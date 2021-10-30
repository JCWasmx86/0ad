/**
 * Emergency manager
 *
 * Checks whether there is an emergency and acts accordingly based on the personality
 * of the AI.
 */
PETRA.EmergencyManager = function(Config)
{
	this.Config = Config;
	this.collectedTroops = false;
	// Counter to delay counting the population and structures
	// to around 3 minutes.
	this.counterForCheckingEmergency = 0;
	// Last number of workers+soldiers+siege machines or structures
	// used for calculating, whether an emergency is there,
	// based on the change.
	this.referencePopulation = 0;
	this.referenceStructureCount = 0;
	// Maximum number of built civic centres
	this.peakCivicCentreCount = -1;
	this.finishedMarching = false;
	// Point to collect in case of emergency
	this.musterPosition = [-1, -1];
	this.sentTributes = false;
	// Used in aggressive: The point where to go next.
	this.nextBattlePoint = [-1, -1];
	// Used for checking, whether to resign.
	this.lastPeopleAlive = -1;
	// A list of all neutrality requests that were sent.
	this.sentRequests = [];
	// Used in defensive: How long to wait to check the
	// number of living people in order to decide, whether
	// this bot resigns.
	this.lastCounter = 0;
	// Counter to wait for until the neutrality requests
	// expire.
	this.neutralityCounter = 0;
	this.finishedWaiting = false;
	// If the number of structures increased/stagnated, but
	// the number of people reduced to less than this threshold factor
	// then trigger an emergency.
	this.attackThreshold = 0.4;

	this.phases = [];
	this.currentPhase = -1;
	this.maxPhase = -1;

	// Used for limiting the amount of marching.
	this.marchCounter = 0;
	// Used as a workaround for walking bug
	this.lastPoint = [-1, -1];
	// Counter for checking whether to return to normal, if defensive+!cooperative
	this.backToNormalCounter = 0;

	this.nearestEnemy = undefined;
	this.emergencyPeakPopulation = 0;
};

PETRA.EmergencyManager.prototype.resetToNormal = function(gameState)
{
	this.initPhases(gameState);
	gameState.emergencyState[PlayerID] = false;
	this.collectedTroops = false;
	this.counterForCheckingEmergency = 0;
	this.referencePopulation = gameState.getPopulation();
	this.referenceStructureCount = gameState.getOwnStructures().length;
	this.peakCivicCentreCount = gameState.getOwnStructures().filter(API3.Filters.byClass("CivCentre")).length;
	this.finishedMarching = false;
	this.musterPosition = [-1, -1];
	this.lastPeopleAlive = -1;
	this.sentTributes = false;
	let cnter = 0;
	for (const threshold of this.phases)
	{
		if (threshold > this.referencePopulation)
			break;
		cnter++;
	}
	this.currentPhase = cnter;
	this.maxPhase = cnter;
	this.marchCounter = 0;
	this.lastPoint = [-1, -1];
	this.backToNormalCounter = 0;
	this.emergencyPeakPopulation = 0;
	// All other fields didn't change.
};

PETRA.EmergencyManager.prototype.initPhases = function(gameState)
{
	const maxPop = gameState.getPopulationMax();
	let lastLimit = 0;
	for (const populationLimit in this.Config.phasesForSteadyDecline)
	{
		if (maxPop === populationLimit)
			break;
		else if (maxPop > populationLimit)
			lastLimit = Number(populationLimit);
		else
		{
			const diffToHigherLimit = Math.abs(maxPop - populationLimit);
			const diffToLowerLimit = Math.abs(maxPop - lastLimit);
			if (diffToHigherLimit >= diffToLowerLimit)
				lastLimit = populationLimit;
			break;
		}
	}
	this.phases = this.Config.phasesForSteadyDecline[lastLimit];
};

PETRA.EmergencyManager.prototype.handleEmergency = function(gameState)
{
	if (!this.collectedTroops)
	{
		const entities = gameState.getOwnEntities().toEntityArray();
		for (const ent of entities)
		{
			if (ent) // 101 to stop everything, not the ones that are finished <=99.
				ent.stopAllProduction(101);
		}
		this.collectTroops(gameState);
		this.collectedTroops = true;
		this.emergencyPeakPopulation = this.countMovableEntities(gameState);
	}
	// Force these people to go to the position, where all others
	// will be to avoid having minor skirmishes that may lead to heavy
	// losses.
	// They will just walk a straight line. A better solution would be
	// to only walk through neutral and allied territory to lose less troops.
	if (this.troopsMarching(gameState))
	{
		if (this.Config.personality.aggressive < this.Config.personality.defensive &&
			this.countMovableEntities(gameState) < this.Config.lossesForResign * this.emergencyPeakPopulation * 0.6)
		{
			this.resign(gameState);
			return;
		}
		this.moveToPoint(gameState, this.musterPosition);
	}
	else
		this.executeActions(gameState);
};

PETRA.EmergencyManager.prototype.moveToPoint = function(gameState, point)
{
	// Otherwise the people would walk a few steps, stay still, continue
	// to walk until the destination is reached.
	if (this.lastPoint === point)
		return;
	this.lastPoint = point;
	for (const ent of gameState.getOwnEntities().toEntityArray())
		if (this.isMovableEntity(ent))
			ent.move(point[0], point[1]);
};
PETRA.EmergencyManager.prototype.hasAvailableTerritoryRoot = function(gameState)
{
	return gameState.getOwnStructures().filter(ent => {
		return ent && ent.get("TerritoryInfluence") !== undefined && ent.get("TerritoryInfluence").Root;
	}).length > 0;
};

PETRA.EmergencyManager.prototype.allowedToTribute = function(gameState, cooperativity)
{
	const lockedTeams = gameState.sharedScript.playersData[PlayerID].teamsLocked;
	return cooperativity >= 0.5 && this.sentTributes && !lockedTeams && gameState.ai.HQ.diplomacyManager.enoughResourcesForTributes(gameState);
};

PETRA.EmergencyManager.prototype.executeActions = function(gameState)
{
	const personality = this.Config.personality;
	if (personality.aggressive < personality.defensive)
	{
		if (this.allowedToTribute(gameState, personality.cooperative))
			this.sentTributes = true;
		else
		{
			if (this.sentTributes && !gameState.ai.HQ.diplomacyManager.expiredNeutralityRequest())
			{
				this.waitForExpiration(gameState);
				return;
			}
			// Check whether to resign. (Here: If more than 75% were killed)
			const movableEntitiesCount = this.countMovableEntities(gameState);
			if (this.lastPeopleAlive === -1)
				this.lastPeopleAlive = movableEntitiesCount;
			if (this.lastCounter < this.Config.resignCheckDelay)
				this.lastCounter++;
			else
			{
				this.lastCounter = 0;
				if (movableEntitiesCount < this.Config.lossesForResign * this.lastPeopleAlive)
				{
					this.resign(gameState);
					return;
				}
				else if (movableEntitiesCount >= this.lastPeopleAlive * ((1 + this.Config.lossesForResign) / 2))
				{
					if (this.backToNormalCounter < this.Config.defensiveStateDuration)
					{
						if (this.backToNormalCounter == Math.round(this.Config.defensiveStateDuration * 0.75))
							gameState.ai.HQ.diplomacyManager.askForResources(gameState);
						this.backToNormalCounter++;
					}
					else if (this.hasAvailableTerritoryRoot(gameState))
					{
						gameState.emergencyState[PlayerID] = false;
						this.resetToNormal(gameState);
						return;
					}
				}
			}
			const halfPatrolRange = this.Config.patrolRange / 2;
			// "Patrol" around the collect position.
			for (const ent of gameState.getOwnEntities().toEntityArray())
			{
				if (!ent.get("Attack") || !ent.position())
					continue;
				const xDeviation = this.generateDeviation(halfPatrolRange);
				const yDeviation = this.generateDeviation(halfPatrolRange);
				if (API3.VectorDistance(ent.position(), this.musterPosition) > this.Config.patrolRange)
					ent.move(this.musterPosition[0] + xDeviation, this.musterPosition[1] + yDeviation);
			}
		}
	}
	else
		this.aggressiveActions(gameState);
};

PETRA.EmergencyManager.prototype.generateDeviation = function(max)
{
	return (Math.random() > 0.5 ? -1 : 1) * Math.floor((Math.random() * max) + 1);
};

PETRA.EmergencyManager.prototype.countMovableEntities = function(gameState)
{
	return gameState.getOwnEntities().toEntityArray().filter(ent => ent.walkSpeed() > 0).length;
};
PETRA.EmergencyManager.prototype.resign = function(gameState)
{
	gameState.getOwnEntities().forEach(ent => ent.destroy());
	var allResources = gameState.ai.queueManager.getAvailableResources(gameState);
	const allies = gameState.getAllies();
	// Just give the first non-dead ally we can find all our resources
	for (const ally of allies)
		if (!gameState.ai.HQ.attackManager.defeated[ally] && ally !== PlayerID)
		{
			const tribute = {};
			for (const resource of Resources.GetTributableCodes())
				tribute[resource] = allResources[resource];
			Engine.PostCommand(PlayerID, { "type": "tribute", "player": ally, "amounts": tribute });
			break;
		}
	Engine.PostCommand(PlayerID, { "type": "resign" });
};

PETRA.EmergencyManager.prototype.waitForExpiration = function(gameState)
{
	const numEnemies = gameState.getEnemies().toEntityArray()
		.filter(enemy => enemy >= 0 && !gameState.ai.HQ.attackManager.defeated[enemy])
		.length;
	if (numEnemies === 0 && this.hasAvailableTerritoryRoot(gameState))
	{
		gameState.emergencyState[PlayerID] = false;
		this.resetToNormal(gameState);
	}
};
PETRA.EmergencyManager.prototype.aggressiveActions = function(gameState)
{
	gameState.getOwnStructures().forEach(ent => ent.destroy());
	// Select initial battle point
	if (this.nextBattlePoint[0] === -1)
	{
		gameState.getOwnEntities().forEach(ent => ent.setStance("violent"));
		this.selectBattlePoint(gameState);
		if (!this.nextBattlePoint)
			return;
	}

	if (!this.isAtBattlePoint(gameState) && this.marchCounter < this.Config.maximumMarchingDuration)
	{
		if (this.nearestEnemy && this.nearestEnemy.position())
			this.nextBattlePoint = this.nearestEnemy.position();
		this.aggressiveAttack(gameState);
		if (this.nearestEnemy && this.nearestEnemy.hitpoints() === 0)
		{
			this.selectBattlePoint(gameState);
			if (!this.nextBattlePoint)
				return;
			this.aggressiveAttack(gameState);
		}
		else
			this.marchCounter++;
	}
	else if (this.nearestEnemy === undefined ||
			this.nearestEnemy.hitpoints() === 0 ||
			this.marchCounter === this.Config.maximumMarchingDuration ||
			!this.noEnemiesNear(gameState))
	{
		this.selectBattlePoint(gameState);
		if (!this.nextBattlePoint)
			return;
		this.aggressiveAttack(gameState);
	}
};

PETRA.EmergencyManager.prototype.aggressiveAttack = function(gameState)
{
	if (this.nearestEnemy === undefined)
		return;
	gameState.getOwnEntities().forEach(ent => ent.attack(this.nearestEnemy.id(), false, false, true));
};

PETRA.EmergencyManager.prototype.validEntity = function(ent)
{
	return ent && ent.position();
};

PETRA.EmergencyManager.prototype.noEnemiesNear = function(gameState)
{
	const averagePosition = this.getAveragePositionOfMovableEntities(gameState);
	return !!gameState.getEnemyEntities().toEntityArray().find(e => this.validEntityWithValidOwner(e) &&
																API3.VectorDistance(e.position(), averagePosition) < this.Config.enemyDetectionRange);
};

PETRA.EmergencyManager.prototype.isMovableEntity = function(ent)
{
	return this.validEntity(ent) && ent.walkSpeed() > 0;
};
PETRA.EmergencyManager.prototype.validEntityWithValidOwner = function(ent)
{
	// Exclude Gaia and INVALID_PLAYER
	return this.validEntity(ent) && ent.owner() > 0;
};

PETRA.EmergencyManager.prototype.selectBattlePoint = function(gameState)
{
	const averagePosition = this.getAveragePositionOfMovableEntities(gameState);
	const enemies = gameState.getEnemyEntities().toEntityArray();
	let nearestEnemy;
	let nearestEnemyDistance = Infinity;
	for (const enemy of enemies)
	{
		if (this.validEntityWithValidOwner(enemy))
		{
			const distance = API3.VectorDistance(enemy.position(), averagePosition);
			if (distance < nearestEnemyDistance)
			{
				nearestEnemy = enemy;
				nearestEnemyDistance = distance;
			}
		}
	}
	this.marchCounter = 0;
	this.nearestEnemy = nearestEnemy;
	if (nearestEnemy && nearestEnemy.position())
		this.nextBattlePoint = nearestEnemy.position();
	else
	{
		// We destroyed all own structures, so we can't do anything besides resigning.
		gameState.getOwnEntities().forEach(ent => ent.destroy());
		Engine.PostCommand(PlayerID, { "type": "resign" });
	}
};

PETRA.EmergencyManager.prototype.getAveragePositionOfMovableEntities = function(gameState)
{
	const entities = gameState.getOwnEntities().toEntityArray();
	if (entities.length === 0)
		return [-1, -1];
	let nEntities = 0;
	let sumX = 0;
	let sumZ = 0;
	for (const ent of entities)
		if (this.isMovableEntity(ent) && !ent.hasClass("Ship"))
		{
			nEntities++;
			const pos = ent.position();
			sumX += pos[0];
			sumZ += pos[1];
		}

	if (nEntities === 0)
		return [-1, -1];
	return [sumX / nEntities, sumZ / nEntities];
};

PETRA.EmergencyManager.prototype.isAtBattlePoint = function(gameState)
{
	const averagePosition = this.getAveragePositionOfMovableEntities(gameState);
	return API3.VectorDistance(averagePosition, this.nextBattlePoint) < 75;
};

PETRA.EmergencyManager.prototype.troopsMarching = function(gameState)
{
	if (this.finishedMarching)
		return false;
	// Ships are excluded, as they can't reach every location.
	if (this.marchCounter < this.Config.maximumMarchingDuration)
	{
		this.marchCounter++;
		for (const ent of gameState.getOwnEntities().toEntityArray())
			if (this.isMovableEntity(ent) && !ent.hasClass("Ship") && API3.VectorDistance(ent.position(), this.musterPosition) > 60)
				return true;
	}
	this.finishedMarching = true;
	return false;
};

PETRA.EmergencyManager.prototype.checkForEmergency = function(gameState)
{
	if (gameState.emergencyState[PlayerID] || this.steadyDeclineCheck(gameState))
		return true;
	if (this.counterForCheckingEmergency < this.Config.fastDestructionDelay)
	{
		this.counterForCheckingEmergency++;
		return false;
	}
	this.counterForCheckingEmergency = 0;
	return this.destructionCheck(gameState);
};

PETRA.EmergencyManager.prototype.steadyDeclineCheck = function(gameState)
{
	const civicCentresCount = gameState.getOwnStructures().filter(API3.Filters.byClass("CivCentre")).length;
	this.peakCivicCentreCount = Math.max(this.peakCivicCentreCount, civicCentresCount);
	if ((civicCentresCount === 0 && this.peakCivicCentreCount >= 1) || this.peakCivicCentreCount - this.Config.civicCentreLossTrigger >= civicCentresCount)
		return true;
	const currentPopulation = gameState.getPopulation();
	if (currentPopulation >= this.phases[this.currentPhase + 1])
	{
		this.currentPhase++;
		this.maxPhase = Math.max(this.currentPhase, this.maxPhase);
	}
	else if (this.currentPhase >= 1 && this.currentPopulation < this.phases[this.currentPhase - 1])
		this.currentPhase--;
	return this.maxPhase - this.currentPhase >= this.phasesToLoseUntilEmergency;
};
/**
 * Check whether this is an emergency. An emergency is, if a lot of
 * people are killed and/or a lot of buildings are destroyed.
 */
PETRA.EmergencyManager.prototype.destructionCheck = function(gameState)
{
	const oldPopulation = this.referencePopulation;
	this.referencePopulation = gameState.getPopulation();
	if (oldPopulation === 0)
		return false;
	const oldNumberOfStructures = this.referenceStructureCount;
	this.referenceStructureCount = gameState.getOwnStructures().length;
	if (oldNumberOfStructures === 0)
		return false;
	const populationFactor = this.referencePopulation / oldPopulation;
	const structureFactor = this.referenceStructureCount / oldNumberOfStructures;
	// Growth means no emergency, no matter the difficulty
	if (populationFactor >= 1 && structureFactor >= 1)
		return false;
	// This means more an attack of the bot, no defense operation,
	// no matter the difficulty.
	if (structureFactor >= 1 || populationFactor >= this.attackThreshold)
		return false;
	const emergencyFactor = this.Config.emergencyFactors[this.Config.difficulty];
	return populationFactor < emergencyFactor[0] || structureFactor < emergencyFactor[1];
};

PETRA.EmergencyManager.prototype.collectTroops = function(gameState)
{
	const entities = gameState.getOwnEntities().toEntityArray();
	if (!entities.length)
		return;
	if (!gameState.getOwnStructures().hasEntities())
		this.musterPosition = this.getAveragePositionOfMovableEntities(gameState);
	else
		this.getSpecialBuildingPosition(entities, gameState);
	this.moveToPoint(gameState, this.musterPosition);
};

PETRA.EmergencyManager.prototype.getSpecialBuildingPosition = function(entities, gameState)
{
	let building;
	var roots = gameState.getOwnStructures().filter(ent => {
		return ent && ent.get("TerritoryInfluence") !== undefined && ent.get("TerritoryInfluence").Root;
	});
	// The optimal solution would be probably getting the average distance from each
	// entity to this building, but this would require a lot of calculation
	if (roots.length)
		building = roots[0];
	if (!this.validEntity(building))
	{
		this.musterPosition = this.getAveragePositionOfMovableEntities(gameState);
		return;
	}
	this.musterPosition = building.position();
};

PETRA.EmergencyManager.prototype.Serialize = function()
{
	return {
		"collectedTroops": this.collectedTroops,
		"counterForCheckingEmergency": this.counterForCheckingEmergency,
		"referencePopulation": this.referencePopulation,
		"referenceStructureCount": this.referenceStructureCount,
		"peakCivicCentreCount": this.peakCivicCentreCount,
		"finishedMarching": this.finishedMarching,
		"musterPosition": this.musterPosition,
		"sentTributes": this.sentTributes,
		"nextBattlePoint": this.nextBattlePoint,
		"lastPeopleAlive": this.lastPeopleAlive,
		"sentRequests": this.sentRequests,
		"lastCounter": this.lastCounter,
		"neutralityCounter": this.neutralityCounter,
		"finishedWaiting": this.finishedWaiting,
		"phases": this.phases,
		"currentPhase": this.currentPhase,
		"maxPhase": this.maxPhase,
		"marchCounter": this.marchCounter,
		"testPoint": this.testPoint,
		"backToNormalCounter": this.backToNormalCounter,
		"nearestEnemy": this.nearestEnemy,
		"emergencyPeakPopulation": this.emergencyPeakPopulation
	};
};

PETRA.EmergencyManager.prototype.Deserialize = function(data)
{
	for (const key in data)
		this[key] = data[key];
};
