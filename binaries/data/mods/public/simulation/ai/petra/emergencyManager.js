PETRA.EmergencyManager = function(config)
{
    this.Config = config;
    this.collectedTroops = false;
};

PETRA.EmergencyManager.prototype.handle = function(gameState)
{
    this.collectTroops(gameState);
};

PETRA.EmergencyManager.prototype.collectTroops = function(gameState)
{
    let entities = gameState.getOwnEntities().toEntityArray();
    if (entities.length == 0)
    {
        return;
    }
    // TODO: Check, for buildings in this order:
    // Civic center, temple, barracks, some tower
    // Else go to the default location.
    let sumX = 0;
    let sumZ = 0;
    for (let ent of entities)
    {
        // Is entity
        API3.warn(JSON.stringify(ent.position()));
        sumX += ent.position()[0];
        sumZ += ent.position()[1];
    }
    let avgX = sumX / entities.length;
    let avgZ = sumZ / entities.length;
    for(let ent of entities)
    {
        ent.move(avgX,avgZ);
    }
}