// SERVER-15310 Ensure that stepDown kills all other running operations

(function() {
"use strict";
var name = "stepdownKillOps";
var replSet = new ReplSetTest({name: name, nodes: 3});
var nodes = replSet.nodeList();
replSet.startSet();
replSet.initiate({
    "_id": name,
    "members": [
        {"_id": 0, "host": nodes[0], "priority": 3},
        {"_id": 1, "host": nodes[1]},
        {"_id": 2, "host": nodes[2], "arbiterOnly": true}
    ]
});

replSet.waitForState(replSet.nodes[0], ReplSetTest.State.PRIMARY);

var primary = replSet.getPrimary();
assert.eq(primary.host, nodes[0], "primary assumed to be node 0");
assert.writeOK(primary.getDB(name).foo.insert({x: 1}, {w: 2, wtimeout: 10000}));
replSet.awaitReplication();

jsTestLog("Sleeping 30 seconds so the SECONDARY will be considered electable");
sleep(30000);

// Run sleep in a separate thread to take the global write lock which would prevent stepdown
// from completing if it failed to kill all running operations.
jsTestLog("Running {sleep:1, lock: 'w'} to grab global write lock");
var sleepCmd = function() {
    // Run for 10 minutes if not interrupted.
    db.adminCommand({sleep: 1, lock: 'w', seconds: 60 * 10});
};
const startTime = new Date().getTime() / 1000;
var sleepRunner = startParallelShell(sleepCmd, primary.port);

jsTestLog("Confirming that sleep() is running and has the global lock");
assert.soon(function() {
    var res = primary.getDB('admin').currentOp();
    for (var index in res.inprog) {
        var entry = res.inprog[index];
        if (entry["command"] && entry["command"]["sleep"]) {
            if ("W" === entry["locks"]["Global"]) {
                return true;
            }
        }
    }
    printjson(res);
    return false;
}, "sleep never ran and grabbed the global write lock");

jsTestLog("Stepping down");
assert.commandWorked(primary.getDB('admin').runCommand({replSetStepDown: 30}));

jsTestLog("Waiting for former PRIMARY to become SECONDARY");
replSet.waitForState(primary, ReplSetTest.State.SECONDARY, 30000);

var newPrimary = replSet.getPrimary();
assert.neq(primary, newPrimary, "SECONDARY did not become PRIMARY");

sleepRunner({checkExitSuccess: false});
const endTime = new Date().getTime() / 1000;
const duration = endTime - startTime;
assert.lt(duration,
          60 * 9,  // In practice, this should be well under 1 minute.
          "Sleep lock held longer than expected, possibly uninterrupted.");

replSet.stopSet();
})();
