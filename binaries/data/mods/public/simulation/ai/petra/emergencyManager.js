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
	this.collectPoint = null;
	this.waitCounter = 0;
	this.chatCounter = 0;
	this.phase = PETRA.EmergencyManager.PHASE_NORMAL;
	this.chatTimer = Math.random() * 500 + 50;
	this.targetToKill = null;
};

PETRA.EmergencyManager.PHASE_NORMAL = 0;
PETRA.EmergencyManager.PHASE_COLLECT = 1;
// JCWASMX86_TODO: Better name
PETRA.EmergencyManager.PHASE_UNSPECIFIED = 2;

PETRA.EmergencyManager.prototype.init = function(gameState)
{
	this.referencePopulation = gameState.getPopulation();
	this.referenceStructureCount = gameState.getOwnStructures().length;
	this.numRoots = this.rootCount(gameState);
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

	// JCWASMX86_TODO: Be configurable?
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
	this.collectUnits(gameState);
	this.sendChatMessage(gameState);
	this.unspecifiedBehavior(gameState);
};

PETRA.EmergencyManager.prototype.unspecifiedBehavior = function(gameState)
{
	if (this.phase !== PETRA.EmergencyManager.PHASE_COLLECT)
	{
		return;
	}
	let personality = this.Config.personality;
	if (personality.aggressive > personality.defensive)
	{
		if (this.targetToKill === null)
		{
			let middle = this.collectPoint;
			let minDistance = Infinity;
			let nearestEnemy = null;
			gameState.getEnemyUnits().toEntityArray().forEach(ent =>
			{
				// JCWASMX86_TODO: Magic number
				if (ent?.healthLevel() < 1.0 && ent.position() !== undefined)
				{
					let distance = API3.SquareVectorDistance(middle, ent.position());
					if (minDistance > distance)
					{
						minDistance = distance;
						nearestEnemy = ent;
					}
				}
			});
			this.targetToKill = nearestEnemy;
			gameState.getOwnUnits().forEach(ent =>
			{
				if (ent?.walkSpeed () > 0 && this.targetToKill !== null)
				{
					ent.attack(this.targetToKill.id(), false);
				}
			});
		}
		else
		{
			if (this.targetToKill.healthLevel() === 0.0)
			{
				this.targetToKill = null;
			}
			if (gameState.getOwnUnits().length == 0)
			{
				for (const ally of allies)
					if (!gameState.ai.HQ.attackManager.defeated[ally] && ally !== PlayerID)
					{
						const tribute = {};
						for (const resource of Resources.GetTributableCodes())
							tribute[resource] = allResources[resource];
						Engine.PostCommand(PlayerID, { "type": "tribute", "player": ally, "amounts": tribute });
						break;
					}
				// Destroy all own buildings
				gameState.getOwnEntities().forEach(ent => ent.destroy());
				Engine.PostCommand(PlayerID, { "type": "resign" });
				return;
			}
		}
	}
	else
	{
		
	}
};

PETRA.EmergencyManager.prototype.sendChatMessage = function(gameState)
{
	if (this.chatCounter < this.chatTimer)
	{
		this.chatCounter++;
		return;
	}
	this.chatCounter = 0;
	this.chatTimer = Math.random() * 500 + 50;
	PETRA.chatEmergencyStatus(gameState, "waiting");
};

PETRA.EmergencyManager.prototype.collectUnits = function(gameState)
{
	if (this.phase !== PETRA.EmergencyManager.PHASE_COLLECT)
	{
		return;
	}
	// JCWASMX86_TODO: Magic number
	if (this.waitCounter == 240)
	{
		// Don't wait for those units that may not be able to reach the
		// meeting point e.g. if there is an ocean between them.
		this.phase = PETRA.EmergencyManager.PHASE_UNSPECIFIED;
		PETRA.chatEmergencyStatus(gameState, "endOfMarch");
		return;
	}
	if (this.collectPoint == null) {
		this.findCollectPoint(gameState);
	}
	gameState.getOwnUnits().forEach(ent =>
	{
		if (ent?.walkSpeed () > 0)
		{
			ent.moveToRange(this.collectPoint[0], this.collectPoint[1], 0, 10, true, true);
		}
	});
	this.waitCounter++;
};

PETRA.EmergencyManager.prototype.findCollectPoint = function(gameState)
{
	let sumX = 0.0;
	let sumZ = 0.0;
	let ownUnits = gameState.getOwnUnits().toEntityArray();
	let count = gameState.getOwnUnits().length;
	gameState.getOwnUnits().forEach(ent =>
	{
		if (ent?.walkSpeed () > 0)
		{
			let pos = ent.position();
			if (pos !== undefined)
			{
				sumX += pos[0];
				sumZ += pos[1];
			}
		}
	});
	let middle = [sumX / count, sumZ / count];
	let minDistance = Infinity;
	let nearestCenter = null;
	gameState.getOwnStructures().toEntityArray().forEach(ent => {
		if (ent?.get("TerritoryInfluence")?.Root === "true")
		{
			let distance = API3.SquareVectorDistance(middle, ent.position());
			if (minDistance > distance)
			{
				minDistance = distance;
				nearestCenter = ent;
			}
		}
	});
	if (minDistance != Infinity)
	{
		this.collectPoint = nearestCenter.position();
	}
	else
	{
		this.collectPoint = middle;
	}
	
};

PETRA.EmergencyManager.prototype.rootCount = function(gameState)
{
	let roots = 0;
	gameState.getOwnStructures().toEntityArray().forEach(ent =>
	{
		if (ent?.get("TerritoryInfluence")?.Root === "true")
			roots++;
	});
	return roots;
};

PETRA.EmergencyManager.prototype.setEmergency = function(gameState, enable)
{
	this.hasEmergency = enable;
	PETRA.chatEmergency(gameState, enable);
	if (!enable)
	{
		this.collectPoint = null;
		this.waitCounter = 0;
		this.collectPoint = null;
		this.waitCounter = 0;
		this.chatCounter = 0;
		this.chatTimer = Math.random() * 500 + 50;
		this.phase = PETRA.EmergencyManager.PHASE_NORMAL;
	}
	else
	{
		this.phase = PETRA.EmergencyManager.PHASE_COLLECT;
	}
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
