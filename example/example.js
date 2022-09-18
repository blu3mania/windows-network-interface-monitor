'use strict';

const NetworkInterfaceMonitor = require('..');

const networkInterface = process.argv.length > 2 ? process.argv[2] : "Local Area Connection";
const addressFamily = process.argv.length > 3 ? process.argv[3] : "IPv4";
const monitor = new NetworkInterfaceMonitor(networkInterface, addressFamily, (address, eventType) => {
    switch (eventType) {
        case NetworkInterfaceMonitor.EventType.Initial:
            // Initial callback
            if (address !== null) {
                print(`Current address: ${address[addressFamily]}`);
            } else {
                print(`Network interface '${networkInterface}' is inactive.`);
            }
            break;

        case NetworkInterfaceMonitor.EventType.IPChanged:
            print(`${addressFamily} address changed: ${address[addressFamily]}`);
            break;

        case NetworkInterfaceMonitor.EventType.IPAssigned:
            print(`Network interface '${networkInterface}' is now active.`);
            print(`${addressFamily} address assigned: ${address[addressFamily]}`);
            break;

        case NetworkInterfaceMonitor.EventType.IPRemoved:
            print(`Network interface '${networkInterface}' is now inactive.`);
            break;
    }
});

main();

function main() {
    print(`Monitoring interface "${networkInterface}"...`);
    if (!monitor.start()) {
        print('Failed to start network interface monitor. Exiting...');
        process.exit(-1);
    }

    process.on('SIGINT', () => {
        print(`SIGINT received. Stop monitoring interface "${networkInterface}" and exiting...`);
        if (!monitor.stop()) {
            error('Failed to stop network interface monitor.');
        }
        process.exit();
    });

    // Use a no-op timer to keep the process running.
    setInterval(() => {}, 60 * 60 * 1000);
}

function print(msg) {
    console.log(`[${new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date())}] ${typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2)}`);
}
