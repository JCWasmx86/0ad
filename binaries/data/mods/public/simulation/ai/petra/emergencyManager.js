PETRA.EmergencyManager = function(config)
{
	this.Config = config;
	this.collectedTroops = false;
	// Counter to delay counting the population and structures
	// to around 3 minutes.
	this.counterForCheckingEmergency = 0;
	// Last number of workers+soldiers+siege machines or structures
	// used for calculating, whether an emergency is there,
	// based on the change.
	this.referencePopulation = 0;
	this.referenceStructureCount = 0;
	this.passed100Pop = false;
	// Maximum number of built civic centres
	this.peakCivicCentreCount = -1;
	this.finishedMarching = false;
	// Point to collect in case of emergency
	this.collectPosition = [-1, -1];
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
};

PETRA.EmergencyManager.prototype.handleEmergency = function(gameState, events)
{
	if (!this.collectedTroops)
	{
		this.collectTroops(gameState);
		this.collectedTroops = true;
	}
	// Force these people to go to the position, where all others
	// will be to avoid having minor skirmishes that may lead to heavy
	// losses.
	// TODO: Maybe say something like: Hold the line! (Motivational speech)
	if (this.troopsMarching(gameState))
		this.moveToPoint(gameState, this.collectPosition);
	else
		this.executeActions(gameState, events);
};

PETRA.EmergencyManager.prototype.moveToPoint = function(gameState, point)
{
	for (const ent of gameState.getOwnEntities().toEntityArray())
		if (this.isMovableEntity(ent))
			ent.move(point[0], point[1]);
};

PETRA.EmergencyManager.prototype.executeActions = function(gameState, events)
{
	const personality = this.Config.personality;
	if (personality.aggressive < personality.defensive)
	{
		// If this bot is cooperative, it will send as much tributes as possible and will
		// try to make peace with every enemy.
		if (personality.cooperative >= 0.5 && this.enoughResourcesForTributes(gameState) && !this.sentTributes)
		{
			const availableResources = gameState.ai.queueManager.getAvailableResources(gameState);
			const enemies = gameState.getEnemies();
			let numEnemies = gameState.getNumPlayerEnemies();
			for (const enemy of enemies)
			{
				if (gameState.ai.HQ.attackManager.defeated[enemy] || enemy == 0)
					continue;
				const tribute = {};
				for (const resource of Resources.GetTributableCodes())
				{
					const tributableResourceCount = availableResources[resource] - 50;
					if (tributableResourceCount <= 0)
					{
						tribute[resource] = 0;
						continue;
					}
					tribute[resource] = Math.round(tributableResourceCount / numEnemies);
				}
				this.sentRequests.push(enemy);
				numEnemies--;
				Engine.PostCommand(PlayerID, { "type": "tribute", "player": enemy, "amounts": tribute });
				Engine.PostCommand(PlayerID, { "type": "diplomacy-request", "source": PlayerID, "player": enemy, "to": "neutral" });
				PETRA.chatNewRequestDiplomacy(gameState, enemy, "neutral", "sendRequest");
			}
			this.sentTributes = true;
		}
		else
		{
			// Check for every changed diplomacy in case of sent
			// neutrality requests.
			if (this.sentTributes && !this.finishedWaiting)
			{
				if (this.neutralityCounter < 30)
				{
					this.neutralityCounter++;
					for (const event of events.DiplomacyChanged)
					{
						if (event.otherPlayer !== PlayerID)
							continue;
						const index = this.sentRequests.indexOf(event.player);
						if (index != -1)
						{
							Engine.PostCommand(PlayerID, { "type": "diplomacy", "player": event.player, "to": "neutral" });
							PETRA.chatNewDiplomacy(gameState, event.player, "neutral");
							this.sentRequests = this.sentRequests.filter(function(value, idx, arr){return idx != index;});
						}
					}
				}
				else
				{
					// Shall we exit emergency mode, if all are neutral now?
					for (const req of this.sentRequests)
						PETRA.chatNewRequestDiplomacy(gameState, req, "neutral", "requestExpired");
					this.finishedWaiting = true;
				}
			}
			// Check whether to resign. (Here: If more than 75% were killed)
			const ownEntities = gameState.getOwnEntities().toEntityArray();
			if (this.lastPeopleAlive == -1)
				this.lastPeopleAlive = ownEntities.length;
			if (this.lastCounter < 5)
				this.lastCounter++;
			else
			{
				this.lastCounter = 0;
				if (ownEntities.length * 4 < this.lastPeopleAlive)
				{
					Engine.PostCommand(PlayerID, { "type": "resign" });
					return;
				}
			}
			// "Patrol" around the collect position.
			for (const ent of ownEntities)
			{
				if (!ent.get("Attack") || !ent.position())
					continue;
				if (API3.VectorDistance(ent.position(), this.collectPosition) > 75)
					ent.move(this.collectPosition[0], this.collectPosition[1]);
			}
		}
	}
	else
	{
		// Select initial battle point
		if (this.nextBattlePoint[0] == -1)
			this.selectBattlePoint(gameState);

		if (!this.isAtBattlePoint(gameState))
			this.moveToPoint(gameState, this.nextBattlePoint);
		else if (this.noEnemiesNear(gameState))
		{
			this.selectBattlePoint(gameState);
			this.moveToPoint(gameState, this.nextBattlePoint);
		}
		// Else wait until we or the enemy are dead.
	}
};

PETRA.EmergencyManager.prototype.validEntity = function(ent)
{
	return ent && ent.position();
};

PETRA.EmergencyManager.prototype.noEnemiesNear = function(gameState)
{
	const averagePosition = this.getAveragePositionOfMovableEntities(gameState);
	for (const enemy of gameState.getEnemyEntities().toEntityArray())
	{
		if (this.validEntity(enemy) && enemy.owner() != 0)
		{
			const distance = API3.VectorDistance(enemy.position(), averagePosition);
			if (distance < this.Config.enemyDetectionRange)
				return false;
		}
	}
	return true;
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
	this.nextBattlePoint = nearestEnemy.position();
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
		if (this.validEntity(ent) && this.isMovableEntity(ent))
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

PETRA.EmergencyManager.prototype.enoughResourcesForTributes = function(gameState)
{
	const availableResources = gameState.ai.queueManager.getAvailableResources(gameState);

	for (const resource of Resources.GetTributableCodes())
		if (availableResources[resource] < 50)
			return false;
	return true;
};

PETRA.EmergencyManager.prototype.troopsMarching = function(gameState)
{
	if (this.finishedMarching)
		return false;
	for (const ent of gameState.getOwnEntities().toEntityArray())
		if (this.isMovableEntity(ent) && API3.VectorDistance(ent.position(), this.collectPosition) > 40)
			return true;
	this.finishedMarching = true;
	return false;
};

PETRA.EmergencyManager.prototype.checkForEmergency = function(gameState)
{
	if (gameState.emergencyState || this.steadyDeclineCheck(gameState))
		return true;
	// TODO: Check, whether this is an appropriate value; currently around 3 minutes
	if (this.counterForCheckingEmergency < 60)
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
	if ((civicCentresCount == 0 && this.peakCivicCentreCount >=1) || this.peakCivicCentreCount - this.Config.civicCentreLossTrigger >= civicCentresCount)
		return true;
	const currentPopulation = gameState.getPopulation();
	if (!this.passed100Pop)
	{
		this.passed100Pop = currentPopulation >= 100;
		return false;
	}
	// When the population was by over 100
	// and now is e.g. over 80, this could mean an attack lead by this
	// bot => No reason for emergency.
	if (currentPopulation >= 60)
		return false;
	return true;
};
/**
 * Check whether an emergency is there. An emergency is, if a lot of
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
	this.ungarrisonAllUnits(gameState);
	const entities = gameState.getOwnEntities().toEntityArray();
	if (entities.length == 0)
		return;
	else if (!gameState.getOwnStructures().hasEntities())
		this.getAveragePosition(gameState);
	else
		this.getSpecialBuildingPosition(entities, gameState);
	this.moveToPoint(gameState, this.collectPosition);
};

PETRA.EmergencyManager.prototype.getSpecialBuildingPosition = function(entities, gameState)
{
	let building;
	// TODO: Find more buildings that are nice points
	// for the probably? last battle. Or collect around hero?
	if (this.hasBuilding(gameState, "CivCentre"))
		building = this.getSpecialBuilding(gameState, "CivCentre", entities);
	else if (this.hasBuilding(gameState, "Temple"))
		building = this.getSpecialBuilding(gameState, "Temple", entities);
	else if (this.hasBuilding(gameState, "Dock"))
		building = this.getSpecialBuilding(gameState, "Dock", entities);

	if (!this.validEntity(building))
	{
		this.getAveragePosition(gameState);
		return;
	}
	const position = building.position();
	this.collectPosition = position;
};

PETRA.EmergencyManager.prototype.hasBuilding = function(gameState, className)
{
	return gameState.getOwnEntitiesByClass(className).hasEntities();
};

// Find the average nearest building of a class for all entities.
PETRA.EmergencyManager.prototype.getSpecialBuilding = function(gameState, className, entities)
{
	let averageWay = Infinity;
	let nearestStructure;
	const potentialStructures = gameState.getOwnEntitiesByClass(className).toEntityArray();
	if (potentialStructures.length == 0)
		return potentialStructures[0];
	for (const structure of potentialStructures)
	{
		if (!this.validEntity(structure))
			continue;
		let sumOfDistance = 0;
		let nEntities = 0;
		for (const ent of entities)
		{
			if (!this.validEntity(ent))
				continue;
			sumOfDistance += API3.VectorDistance(structure.position(), ent.position());
			nEntities++;
		}
		if (nEntities == 0)
			continue;
		const avgWayToThisStructure = sumOfDistance / nEntities;
		if (averageWay > avgWayToThisStructure)
		{
			averageWay = avgWayToThisStructure;
			nearestStructure = structure;
		}
	}
	return nearestStructure;
};

PETRA.EmergencyManager.prototype.getAveragePosition = function(gameState)
{
	this.collectPosition = this.getAveragePositionOfMovableEntities(gameState);
};

PETRA.EmergencyManager.prototype.ungarrisonAllUnits = function(gameState) {
	const structures = gameState.getOwnStructures().toEntityArray();
	for (const structure of structures)
	{
		const garrisoned = structure.garrisoned();
		if (garrisoned)
		{
			for (const entId of garrisoned)
			{
				const ent = gameState.getEntityById(entId);
				if (ent.owner() === PlayerID)
					structure.unload(entId);
			}
		}
	}
};

PETRA.EmergencyManager.prototype.Serialize = function()
{
	return {
		"collectedTroops": this.collectedTroops,
		"counterForCheckingEmergency": this.counterForCheckingEmergency,
		"referencePopulation": this.referencePopulation,
		"referenceStructureCount": this.referenceStructureCount,
		"passed100Pop": this.passed100Pop,
		"peakCivicCentreCount": this.peakCivicCentreCount,
		"finishedMarching": this.finishedMarching,
		"collectPosition": this.collectPosition,
		"sentTributes": this.sentTributes,
		"nextBattlePoint": this.nextBattlePoint,
		"lastPeopleAlive": this.lastPeopleAlive,
		"sentRequests": this.sentRequests,
		"lastCounter": this.lastCounter,
		"neutralityCounter": this.neutralityCounter,
		"finishedWaiting": this.finishedWaiting
	};
};

PETRA.EmergencyManager.prototype.Deserialize = function(data)
{
	for (const key in data)
		this[key] = data[key];
};
