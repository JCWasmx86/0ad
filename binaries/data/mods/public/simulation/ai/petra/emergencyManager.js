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

	this.nearestEnemy = null;
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
	this.sentTributes = false;
	let cnter = 0;
	for (const treshold of this.phases)
	{
		if (treshold > this.referencePopulation)
			break;
		cnter++;
	}
	this.currentPhase = cnter;
	this.maxPhase = cnter;
	this.marchCounter = 0;
	this.lastPoint = [-1, -1];
	this.backToNormalCounter = 0;
	// All other fields didn't change.
};

PETRA.EmergencyManager.prototype.initPhases = function(gameState)
{
	const maxPop = gameState.getPopulationMax();
	let lastLimit = 0;
	for (const populationLimit in this.Config.phasesForSteadyDecline)
	{
		if (maxPop == populationLimit)
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

PETRA.EmergencyManager.prototype.handleEmergency = function(gameState, events)
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
	}
	// Force these people to go to the position, where all others
	// will be to avoid having minor skirmishes that may lead to heavy
	// losses.
	// TODO: Maybe say something like: Hold the line! (Motivational speech)
	if (this.troopsMarching(gameState))
		this.moveToPoint(gameState, this.musterPosition);
	else
		this.executeActions(gameState, events);
};

PETRA.EmergencyManager.prototype.moveToPoint = function(gameState, point)
{
	// Otherwise the people would walk a few steps, stay still, continue
	// to walk until the destination is reached.
	if (this.lastPoint == point)
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
	}).length != 0;
};

PETRA.EmergencyManager.prototype.executeActions = function(gameState, events)
{
	const personality = this.Config.personality;
	if (personality.aggressive < personality.defensive)
	{
		API3.warn("Defensive");
		if (personality.cooperative >= 0.5 &&
			!this.sentTributes &&
			!gameState.sharedScript.playersData[PlayerID].teamsLocked &&
			gameState.ai.HQ.diplomacyManager.enoughResourcesForTributes(gameState))
		{
			API3.warn("Sent tributes!");
			this.sentTributes = true;
		}
		else
		{
			if (this.sentTributes && !gameState.ai.HQ.diplomacyManager.expiredNeutralityRequest())
			{
				API3.warn("Waiting until neutrality!");
				const enemies = gameState.getEnemies();
				var numEnemies = 0;
				for (const enemy of enemies)
				{
					if (enemy <= 0 || gameState.ai.HQ.attackManager.defeated[enemy])
						continue;
					numEnemies++;
				}
				API3.warn("" + numEnemies + " are left!");
				if (numEnemies == 0)
				{
					if (this.hasAvailableTerritoryRoot(gameState))
					{
						API3.warn("Back to normal");
						gameState.emergencyState[PlayerID] = false;
						this.resetToNormal(gameState);
					}
					else
					{
						API3.warn("No root found");
					}
					return;
				}
				if (!gameState.ai.HQ.diplomacyManager.expiredNeutralityRequest())
				{
					API3.warn("Still waiting");
					return;
				}
				API3.warn("Expired!");
				gameState.ai.HQ.diplomacyManager.expireNeutraliyRequests(gameState);
				return;
			}
			API3.warn("HEREEEE!");
			// Check whether to resign. (Here: If more than 75% were killed)
			const ownEntities = gameState.getOwnEntities().toEntityArray();
			let movableEntitiesCount = 0;
			for (const ent of ownEntities)
			{
				if (ent.walkSpeed() > 0)
					movableEntitiesCount++;
			}
			if (this.lastPeopleAlive == -1)
				this.lastPeopleAlive = movableEntitiesCount;
			if (this.lastCounter < this.Config.resignCheckDelay)
				this.lastCounter++;
			else
			{
				this.lastCounter = 0;
				if (movableEntitiesCount < this.Config.lossesForResign * this.lastPeopleAlive)
				{
					var allResources = gameState.ai.queueManager.getAvailableResources(gameState);
					const allies = gameState.getAllies();
					// Just give the first non-dead ally we can find all our resources
					for (const ally of allies)
						if (!gameState.ai.HQ.attackManager.defeated[ally])
						{
							const tribute = {};
							for (const resource of Resources.GetTributableCodes())
								tribute[resource] = allResources[resource];
							Engine.PostCommand(PlayerID, { "type": "tribute", "player": ally, "amounts": tribute });
							break;
						}
					Engine.PostCommand(PlayerID, { "type": "resign" });
					return;
				}
				else if (movableEntitiesCount >= this.lastPeopleAlive * ((1 + this.Config.lossesForResign) / 2))
				{
					API3.warn("Waiting until returning: " + this.backToNormalCounter + "/" + this.Config.defensiveStateDuration);
					if (this.backToNormalCounter < this.Config.defensiveStateDuration)
						this.backToNormalCounter++;
					else if (this.hasAvailableTerritoryRoot(gameState))
					{
						API3.warn("defensive + !cooperative: Back to normal");
						gameState.emergencyState[PlayerID] = false;
						this.resetToNormal(gameState);
						return;
					}
				}
			}
			// "Patrol" around the collect position.
			for (const ent of ownEntities)
			{
				if (!ent.get("Attack") || !ent.position())
					continue;
				if (API3.VectorDistance(ent.position(), this.musterPosition) > this.Config.patrolRange)
					ent.move(this.musterPosition[0], this.musterPosition[1]);
			}
		}
	}
	else
	{
		// TODO: Destroy all our buildings?
		API3.warn("Aggressive");
		// Select initial battle point
		if (this.nextBattlePoint[0] == -1)
		{
			for (const ent of gameState.getOwnEntities().toEntityArray())
				ent.setStance("violent");
			this.selectBattlePoint(gameState);
			if (!this.nextBattlePoint)
				return;
			API3.warn("Initial point: " + this.nextBattlePoint);
			API3.warn(this.nearestEnemy.toString());
		}

		if (!this.isAtBattlePoint(gameState) && this.marchCounter < this.Config.maximumMarchingDuration)
		{
			API3.warn(this.marchCounter + "//" + this.Config.maximumMarchingDuration);
			if (this.nearestEnemy && this.nearestEnemy.position())
				this.nextBattlePoint = this.nearestEnemy.position();
			this.aggressiveAttack(gameState);
			if (this.nearestEnemy && this.nearestEnemy.hitpoints() == 0)
			{
				this.selectBattlePoint(gameState);
				if (!this.nextBattlePoint)
					return;
				this.aggressiveAttack(gameState);
				API3.warn("New: " + this.nearestEnemy.toString());
			}
			else
				this.marchCounter++;
		}
		else if (this.nearestEnemy == undefined ||
				this.nearestEnemy.hitpoints() == 0 ||
				this.marchCounter == this.Config.maximumMarchingDuration ||
				!this.noEnemiesNear(gameState))
		{
			this.selectBattlePoint(gameState);
			if (!this.nextBattlePoint)
				return;
			this.aggressiveAttack(gameState);
			API3.warn("Entity: " + this.nearestEnemy.toString());
		}
		// Else wait until we or the enemy are dead.
	}
};

PETRA.EmergencyManager.prototype.aggressiveAttack = function(gameState)
{
	for (const ent of gameState.getOwnEntities().toEntityArray())
	{
		// ent.attackMove(this.nearestEnemy.position()[0], this.nearestEnemy.position()[1], targetClasses, false, true);
		ent.attack(this.nearestEnemy.id(), false, false, true);
		// ent.move(this.nearestEnemy.position()[0], this.nearestEnemy.position()[1]);
	}
};

PETRA.EmergencyManager.prototype.validEntity = function(ent)
{
	return ent && ent.position();
};

PETRA.EmergencyManager.prototype.noEnemiesNear = function(gameState)
{
	const averagePosition = this.getAveragePositionOfMovableEntities(gameState);
	return !!gameState.getEnemyEntities().toEntityArray().find(e => this.validEntity(e) &&
																e.owner() > 0 &&
																API3.VectorDistance(e.position(), averagePosition) < this.Config.enemyDetectionRange);
};

PETRA.EmergencyManager.prototype.isMovableEntity = function(ent)
{
	return this.validEntity(ent) && ent.walkSpeed() > 0;
};

PETRA.EmergencyManager.prototype.selectBattlePoint = function(gameState)
{
	const averagePosition = this.getAveragePositionOfMovableEntities(gameState);
	const enemies = gameState.getEnemyEntities().toEntityArray();
	let nearestEnemy;
	let nearestEnemyDistance = Infinity;
	for (const enemy of enemies)
	{
		// Exclude Gaia and INVALID_PLAYER
		if (this.validEntity(enemy) && enemy.owner() > 0)
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
	else  // TODO: Destroy all own buildings
		Engine.PostCommand(PlayerID, { "type": "resign" });
};

PETRA.EmergencyManager.prototype.getAveragePositionOfMovableEntities = function(gameState)
{
	const entities = gameState.getOwnEntities().toEntityArray();
	if (entities.length == 0)
		return [-1, -1];
	let nEntities = 0;
	let sumX = 0;
	let sumZ = 0;
	for (const ent of entities)
	{
		if (this.validEntity(ent) && this.isMovableEntity(ent) && !ent.hasClass("Ship"))
		{
			nEntities++;
			const pos = ent.position();
			sumX += pos[0];
			sumZ += pos[1];
		}
	}

	if (nEntities == 0)
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
	if ((civicCentresCount == 0 && this.peakCivicCentreCount >= 1) || this.peakCivicCentreCount - this.Config.civicCentreLossTrigger >= civicCentresCount)
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
	if (oldPopulation == 0)
		return false;
	const oldNumberOfStructures = this.referenceStructureCount;
	this.referenceStructureCount = gameState.getOwnStructures().length;
	if (oldNumberOfStructures == 0)
		return false;
	const populationFactor = this.referencePopulation / oldPopulation;
	const structureFactor = this.referenceStructureCount / oldNumberOfStructures;
	// Growth means no emergency, no matter the difficulty
	if (populationFactor >=1 && structureFactor >= 1)
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

PETRA.EmergencyManager.prototype.getAveragePosition = function(gameState)
{
	this.musterPosition = this.getAveragePositionOfMovableEntities(gameState);
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
		"nearestEnemy": this.nearestEnemy
	};
};

PETRA.EmergencyManager.prototype.Deserialize = function(data)
{
	for (const key in data)
		this[key] = data[key];
};
