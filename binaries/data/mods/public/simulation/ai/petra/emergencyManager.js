/**
 * Checks for emergencies and acts accordingly
 */
PETRA.EmergencyManager = function(Config)
{
	this.Config = Config;
	this.referencePopulation = 0;
	this.referenceStructureCount = 0;
	this.numRoots = 0;
	this.hasEmergency = false;
};

// There is no emergency
PETRA.EmergencyManager.STATE_NONE = "none";
// We detected an emergency, but haven't acted upon it,
// except sending a chat message.
PETRA.EmergencyManager.STATE_INITIAL = "initial";
// We are waiting for the units to move after the initial shock
PETRA.EmergencyManager.STATE_WAITING_FOR_MOVE = "waitingForMove";
// We asked our allies for help and resources
PETRA.EmergencyManager.STATE_WAITING_FOR_RESOURCES = "waitingForResources";
// Self-destruction by gifting resources and then attacking
// the units of the enemies.
PETRA.EmergencyManager.STATE_SELFDESTRUCTION = "selfDestruction";
// Idling to preserve units
PETRA.EmergencyManager.STATE_IDLING = "idling";

PETRA.EmergencyManager.prototype.init = function(gameState)
{
	this.referencePopulation = gameState.getPopulation();
	this.referenceStructureCount = gameState.getOwnStructures().length;
	this.numRoots = this.rootCount(gameState);
	this.state = PETRA.EmergencyManager.STATE_NONE;
	this.counter = 0;
	this.resCounter = 0;
};

PETRA.EmergencyManager.prototype.update = function(gameState)
{
	if (this.hasEmergency)
	{
		this.emergencyUpdate(gameState);
		return;
	}
	const pop = gameState.getPopulation();
	const nStructures = gameState.getOwnStructures().length;
	const nRoots = this.rootCount(gameState);
	const factors = this.Config.emergencyValues;
	if (((pop / this.referencePopulation) < factors.population || pop == 0) &&
		((nStructures / this.referenceStructureCount) < factors.structures || nStructures == 0))
		this.setEmergency(gameState, true);
	else if ((nRoots / this.numRoots) <= factors.roots || (nRoots == 0 && this.numRoots != 0))
		this.setEmergency(gameState, true);

	if (pop > this.referencePopulation || this.hasEmergency)
		this.referencePopulation = pop;
	if (nStructures > this.referenceStructureCount || this.hasEmergency)
		this.referenceStructureCount = nStructures;
	if (nRoots > this.numRoots || this.hasEmergency)
		this.numRoots = nRoots;
};

PETRA.EmergencyManager.prototype.emergencyUpdate = function(gameState)
{
	const pop = gameState.getPopulation();
	const nStructures = gameState.getOwnStructures().length;
	const nRoots = this.rootCount(gameState);
	const factors = this.Config.emergencyValues;

	if ((pop > this.referencePopulation * 1.2 &&
		nStructures > this.referenceStructureCount * 1.2) ||
		nRoots > this.numRoots)
	{
		this.setEmergency(gameState, false);
		this.referencePopulation = pop;
		this.referenceStructureCount = nStructures;
		this.numRoots = nRoots;
		return;
	}
	if (this.state == PETRA.EmergencyManager.STATE_INITIAL)
	{
		this.counter = 0;
		const allycc = gameState.getExclusiveAllyEntities().filter(API3.Filters.byClass("CivCentre")).toEntityArray();
		if (!allycc.length)
		{
			this.state = PETRA.EmergencyManager.STATE_WAITING_FOR_MOVE;
			return;
		}
		this.bestcc = allycc[0]; // TODO
		for (const ent of gameState.getOwnUnits().values())
		{
			const range = 1.5 * this.bestcc.footprintRadius();
			ent.moveToRange(this.bestcc.position()[0], this.bestcc.position()[1], range, range + 2, false, true);
		}
		this.state = PETRA.EmergencyManager.STATE_WAITING_FOR_MOVE;
	}
	else if (this.state == PETRA.EmergencyManager.STATE_WAITING_FOR_MOVE)
	{
		this.counter++;
		if (this.counter % 10 == 0)
		{
			for (const ent of gameState.getOwnUnits().values())
			{
				const range = 1.5 * this.bestcc.footprintRadius();
				ent.moveToRange(this.bestcc.position()[0], this.bestcc.position()[1], range, range + 2, false, true);
			}
		}
		if (this.counter == 120) // TODO: Extract as constant
		{
			if (pop < this.referencePopulation / 2)
			{
				this.state = PETRA.EmergencyManager.STATE_SELFDESTRUCTION;
			}
			else
			{
				this.state = PETRA.EmergencyManager.STATE_WAITING_FOR_RESOURCES;
				this.counter = 0;
				this.resCounter = 0;
			}
		}
	}
	else if (this.state == PETRA.EmergencyManager.STATE_WAITING_FOR_RESOURCES)
	{
		this.counter++;
		if (this.counter == 40)
		{
			const resTribCodes = Resources.GetTributableCodes();
			PETRA.chatRequestTribute(gameState, pickRandom(resTribCodes));
			this.counter = 0;
			this.resCounter++;
		}
		if (this.resCounter == 3)
		{
			if (pop < this.referencePopulation / 2)
			{
				this.state = PETRA.EmergencyManager.STATE_SELFDESTRUCTION;
			}
			else
			{
				this.state = PETRA.EmergencyManager.STATE_IDLING;
			}
		}
	}
	else if (this.state == PETRA.EmergencyManager.STATE_IDLING)
	{
		if (pop < this.referencePopulation / 3)
		{
			this.state = PETRA.EmergencyManager.STATE_SELFDESTRUCTION;
		}
	}
	else if (this.state == PETRA.EmergencyManager.STATE_SELFDESTRUCTION)
	{
		PETRA.chatEmergencyState(gameState, enable, "selfdestruction");
		const resTribCodes = Resources.GetTributableCodes();
		for (let i = 1; i < gameState.sharedScript.playersData.length; ++i)
		{
			if (i === PlayerID || !gameState.isPlayerAlly(i) || gameState.ai.HQ.attackManager.defeated[i])
				continue;
			const tribute = {};
			const totalResources = gameState.getResources();
			for (const res of resTribCodes)
			{
				tribute[res] = totalResources[res];
			}
			if (this.Config.chat)
				PETRA.chatSentTribute(gameState, i);
			Engine.PostCommand(PlayerID, { "type": "tribute", "player": i, "amounts": tribute });
			break;
		}
		gameState.getOwnStructures().forEach(ent => ent.destroy());
		gameState.getOwnEntities().forEach(ent => ent.setStance("violent"));
		if (pop < this.referencePopulation / 20 || pop < 5)
		{
			Engine.PostCommand(PlayerID, { "type": "resign" });
			return;
		}
		for (const ent of gameState.getOwnEntities())
		{
			const enemyToFind = pickRandom(gameState.getEnemyEntities());
			ent.attack(enemyToFind.id(), false, false, true);
		}
	}
};

PETRA.EmergencyManager.prototype.rootCount = function(gameState)
{
	let roots = 0;
	gameState.getOwnStructures().toEntityArray().forEach(ent => {
		if (ent?.get("TerritoryInfluence")?.Root === "true")
			roots++;
	});
	return roots;
};

PETRA.EmergencyManager.prototype.setEmergency = function(gameState, enable)
{
	this.state = enable ? PETRA.EmergencyManager.STATE_INITIAL : PETRA.EmergencyManager.STATE_NONE;
	this.hasEmergency = enable;
	PETRA.chatEmergency(gameState, enable);
};

PETRA.EmergencyManager.prototype.Serialize = function()
{
	return {
		"referencePopulation": this.referencePopulation,
		"referenceStructureCount": this.referenceStructureCount,
		"numRoots": this.numRoots,
		"hasEmergency": this.hasEmergency
	};
};

PETRA.EmergencyManager.prototype.Deserialize = function(data)
{
	for (const key in data)
		this[key] = data[key];
};
