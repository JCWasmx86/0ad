// TODO: (De)Serialization
PETRA.EmergencyManager = function(config)
{
	this.Config = config;
	this.collectedTroops = false;
	this.counterForCheckingEmergency = 0;
	this.population = 0;
	this.numberOfStructures = 0;
	this.passed100Pop = false;
	this.peakCivicCentreCount = 0;
	this.finishedMarching = false;
	this.collectPosition = [];
};

PETRA.EmergencyManager.prototype.handleEmergency = function(gameState)
{
	if (!this.collectedTroops)
	{
		this.collectTroops(gameState);
		this.collectedTroops = true;
	}
	// Force these people to go to the position, where all others
	// will be to avoid having minor skirmishes that may lead to heavy
	// losses.
	if (this.troopsMarching(gameState))
	{
		API3.warn("FOO")
		for (let ent of gameState.getOwnEntities().toEntityArray())
			ent.move(this.collectPosition[0], this.collectPosition[1]);
	}
	else
	{
		// TODO: Actions depending on aggressive, cooperative, defensive
		// If aggressive: One final battle
		// If cooperative + defensive: Send resources to every? enemy to make peace
		// If defensive: Make last battle or flee to the next ally?
		// Maybe say something like: Hold the line! (Motivational speech)
		this.executeActions(gameState);
	}
};
PETRA.EmergencyManager.prototype.executeActions = function(gameState)
{
	let personality = this.Config.personality;
	API3.warn(JSON.stringify(personality));
	if (personality.aggressive < personality.defensive)
	{
		if(personality.cooperative >= 0.5 && this.enoughResourcesForTributes(gameState))
		{
			let availableResources = gameState.ai.queueManager.getAvailableResources(gameState);
			let enemies = gameState.getEnemies();
			let numEnemies = gameState.getNumPlayerEnemies();
			for (let enemy of enemies)
			{
				if(gameState.ai.HQ.attackManager.defeated[i])
				{
					continue;
				}
				let tribute = {};
				for (let resource of Resources.GetTributableCodes())
				{
					let tributableResourceCount = availableResources[resource] - 50;
					tribute[resource] = tributableResourceCount / numEnemies;
					numEnemies--;
				}
				Engine.PostCommand(PlayerID, { "type": "tribute", "player": enemy, "amounts": tribute });
				let neutralityRequest = new Map();
				neutralityRequest.set(enemy, {
					"requestType": "neutral",
					"timeSent": gameState.ai.elapsedTime
				});
				Engine.PostCommand(PlayerID, { "type": "diplomacy-request", "source": PlayerID, "player": enemy, "to": requestType });
				PETRA.chatNewRequestDiplomacy(gameState, enemy, requestType, "sendRequest");
			}
		}
		else
		{
			
		}
	}
	else
	{

	}
};

PETRA.EmergencyManager.prototype.enoughResourcesForTributes = function(gameState)
{
	let availableResources = gameState.ai.queueManager.getAvailableResources(gameState);
	for (let resource of Resources.GetTributableCodes())
	{
		if (availableResources[resource] < 50)
		{
			return false;
		}
	}
	return true;
};

PETRA.EmergencyManager.prototype.troopsMarching = function(gameState)
{
	if(this.finishedMarching)
		return false;
	for (let ent of gameState.getOwnEntities().toEntityArray())
	{
		if (ent && ent.position()&& ent.walkSpeed() > 0 /*???*/ && API3.VectorDistance(ent.position(), this.collectPosition) > 40)
		{
			return true;
		}
	}
	this.finishedMarching = true;
	return false;
};

PETRA.EmergencyManager.prototype.checkForEmergency = function(gameState)
{
	if (gameState.emergencyState || this.steadyDeclineCheck(gameState))
		return true;
	// TODO: Check, whether this is an appropriate value, currently around 3 minutes
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
	let civicCentresCount = gameState.getOwnStructures().filter(API3.Filters.byClass("CivCentre")).length;
	this.peakCivicCentreCount = Math.max(this.peakCivicCentreCount, civicCentresCount);
	if (civicCentresCount == 0 || this.peakCivicCentreCount - 2 >= civicCentresCount)
		return true;
	let currentPopulation = gameState.getPopulation();
	if (!this.passed100Pop)
	{
		this.passed100Pop = currentPopulation >= 100;
		return false;
	}
	// When the population was by over 100
	// and now is over 80, this could mean an attack lead by this
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
	let oldPopulation = this.population;
	this.population = gameState.getPopulation();
	if (oldPopulation == 0)
		return false;
	let oldNumberOfStructures = this.numberOfStructures;
	this.numberOfStructures = gameState.getOwnStructures().length;
	if (oldNumberOfStructures == 0)
		return false;
	let populationFactor = this.population / oldPopulation;
	let structureFactor = this.numberOfStructures / oldNumberOfStructures;
	// Growth means no emergency, no matter the difficulty
	if (populationFactor >=1 && structureFactor >= 1)
		return false;
	// This means more an attack of the bot, no defense operation,
	// no matter the difficulty.
	if (structureFactor >= 1 || populationFactor >= 0.4)
		return false;
	let resignFactors = [
		// [<popFactor>,<structureFactor>]
		// Sandbox, never emergency
		[0.0,0.0],
		// Very easy
		[0.8,0.8],
		// Easy
		[0.7,0.7],
		// Medium
		[0.6,0.6],
		// Hard
		[0.2,0.2],
		// Very hard, never emergency
		[0.0,0.0]
	];
	let resignFactor = resignFactors[this.Config.difficulty];
	return populationFactor < resignFactor[0] || structureFactor < resignFactor[1];
};

PETRA.EmergencyManager.prototype.collectTroops = function(gameState)
{
	this.ungarrisonAllUnits(gameState);
	let entities = gameState.getOwnEntities().toEntityArray();
	if (entities.length == 0)
	{
		return;
	}
	else if (!gameState.getOwnStructures().hasEntities())
	{
		this.collectInAveragePosition(entities, gameState);
		return;
	}
	else
	{
		this.gotoSpecialBuilding(entities, gameState);
	}
};

PETRA.EmergencyManager.prototype.gotoSpecialBuilding = function(entities, gameState)
{
	let building;
	// TODO: Unify; Find more buildings that are nice points
	// for the probably? last battle.
	if (this.hasBuilding(gameState, "CivCentre"))
		building = this.getSpecialBuilding(gameState, "CivCentre", entities);
	else if (this.hasBuilding(gameState, "Temple"))
		building = this.getSpecialBuilding(gameState, "Temple", entities);
	else if (this.hasBuilding(gameState, "Dock"))
		building = this.getSpecialBuilding(gameState, "Dock", entities);

	if (!building)
	{
		this.collectInAveragePosition(entities, gameState);
		return;
	}
	let position = building.position();
	API3.warn(JSON.stringify(position));
	this.collectPosition = position;
	for(let ent of entities)
	{
		ent.move(position[0],position[1]);
	}
};

PETRA.EmergencyManager.prototype.hasBuilding = function(gameState, className)
{
	return gameState.getOwnEntitiesByClass(className).hasEntities();
};
PETRA.EmergencyManager.prototype.getSpecialBuilding = function(gameState, className, entities)
{
	let averageWay = 1000000;
	let nearestStructure;
	let potentialStructures = gameState.getOwnEntitiesByClass(className).toEntityArray();
	if(potentialStructures.length == 0)
		return potentialStructures[0];
	for(let structure of potentialStructures)
	{
		if (!structure || !structure.position())
			continue;
		let sumOfDistance = 0;
		let nEntities = 0;
		for(let ent of entities)
		{
			if(!ent || !ent.position())
				continue;
			sumOfDistance += API3.VectorDistance(structure.position(), ent.position());
			nEntities++;
		}
		if(nEntities == 0)
			continue;
		let avgWayToThisStructure = sumOfDistance / nEntities;
		if(averageWay > avgWayToThisStructure)
		{
			averageWay = avgWayToThisStructure;
			nearestStructure = structure;
		}
	}
	return nearestStructure;
};

PETRA.EmergencyManager.prototype.collectInAveragePosition = function(entities, gameState)
{
	let sumX = 0;
	let sumZ = 0;
	let nEntities = 0;
	for (let ent of entities)
	{
		if (!ent || !ent.position())
			continue;
		sumX += ent.position()[0];
		sumZ += ent.position()[1];
		nEntities++;
	}
	if (nEntities == 0)
		return;
	let avgX = sumX / nEntities;
	let avgZ = sumZ / nEntities;
	this.collectPosition = Array.of(avgX, avgZ);
	for(let ent of entities)
	{
		if (ent && ent.position())
		{
			ent.move(avgX,avgZ);
			ent.setStance("standground");
		}
	}
};
PETRA.EmergencyManager.prototype.ungarrisonAllUnits = function(gameState) {
	let structures = gameState.getOwnStructures().toEntityArray();
	for (let structure of structures)
	{
		let garrisoned = structure.garrisoned();
		if (garrisoned)
		{
			for (let entId of garrisoned)
			{
				let ent = gameState.getEntityById(entId);
				if (ent.owner() === PlayerID)
						structure.unload(entId);
			}
		}
	}
};
