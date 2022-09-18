'use strict';

const os = require('os');

let family = null;
if (process.argv.length > 2) {
    family = process.argv[2].toLowerCase();
    if (family === '4' || family === 'v4') {
        family = 'ipv4';
    } else if (family === '6' || family === 'v6') {
        family = 'ipv6';
    }
}

const interfaces = os.networkInterfaces();
for (const name in interfaces) {
    interfaces[name] = interfaces[name].filter(ipAddress => {
        if (family === null || ipAddress.family.toLowerCase() === family) {
            for (const property in ipAddress) {
                if (property !== 'address' && (property !== 'family' || family !== null)) {
                    delete ipAddress[property];
                }
            }
            return true;
        }

        return false;
    });
}

console.log(JSON.stringify(interfaces, null, 2));
