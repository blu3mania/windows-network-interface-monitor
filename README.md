# windows-network-interface-monitor
[![Apache 2.0 License](https://img.shields.io/badge/License-Apache%202.0-yellow)](https://raw.githubusercontent.com/blu3mania/windows-network-interface-monitor/main/LICENSE)
[![node.js 16+](https://img.shields.io/badge/node.js-16.0.0-blue?logo=node.js)](https://nodejs.org/en/)
[![Latest Release](https://img.shields.io/github/v/release/blu3mania/windows-network-interface-monitor)](https://github.com/blu3mania/windows-network-interface-monitor/releases/latest)

This library provides the ability to monitor a network interface on Windows for IP changes.

## Installation

It is recommended to use npm to install windows-network-interface-monitor:

`npm install  windows-network-interface-monitor`

Note that the required package "ffi-napi" uses native modules and relies on "node-gyp" to build the project.
As a result, there are some prerequisites that need to be installed/configured. Please refer to [node-gyp's
instructions](https://github.com/nodejs/node-gyp#installation).

## Usage
First, find out the network interface to monitor for. The name should be obtained from the output of
os.networkInterfaces(), and not from Windows command "ipconfig":
```
console.log(JSON.stringify(require('os').networkInterfaces(), null, 2));
```

For your convenience, a utility show-interfaces.js is provided. Just run
"`node lib/show-interfaces.js [ipv4|ipv6]`"
to find out the list of network interfaces and their assigned IP addresses. Sample output from
"`node lib/show-interfaces.js`":
```
{
  "Ethernet": [
    {
      "address": "fe80::200:ff:fe00:0",
      "family": "IPv6"
    },
    {
      "address": "192.168.0.1",
      "family": "IPv4"
    }
  ],
  "Loopback Pseudo-Interface 1": [
    {
      "address": "::1",
      "family": "IPv6"
    },
    {
      "address": "127.0.0.1",
      "family": "IPv4"
    }
  ]
}
```

Pass this interface name as the first parameter in NetworkInterfaceMonitor's constructor. The second
parameter is the address family to monitor for. Valid values are "IPv4", "IPv6", and "Any", which means
both. The last parameter is the callback function. The monitor will pass 2 parameters to this callback:
- address - This is an object that has monitored address families as properties and corresponding IP
  addresses as property values. For example, to get IPv4 address, use `address.IPv4`.
- eventType - The type of event that triggered this notification. Defined values are:
  - NetworkInterfaceMonitor.EventType.Initial: initial callback when monitor is started. A convenient
    way to obtain current IP address.
  - NetworkInterfaceMonitor.EventType.IPChanged: when IP assigned to the network interface has changed.
  - NetworkInterfaceMonitor.EventType.IPAssigned: when an IP is assigned to the network interface. This
    usually happens when the network is activated, e.g. connecting to Wi-Fi  or a VPN adapter.
  - NetworkInterfaceMonitor.EventType.IPRemoved: when previous IP assignment of the network interface
    is removed. This usually happens when the network is deactivated, e.g. disconnecting from Wi-Fi or
    a VPN adapter.

After instantiating a NetworkInterfaceMonitor, call start() on it to start the monitor.

When the monitor is no longer needed, *make sure to call stop()* to properly release the underlying
handle obtained from Windows native API.

## Example

```
var NetworkInterfaceMonitor = require('windows-network-interface-monitor');
var networkInterface = "Local Area Connection";
var addressFamily = "IPv4";

var monitor = new NetworkInterfaceMonitor(networkInterface, addressFamily, (address, eventType) => {
    switch (eventType) {
        case NetworkInterfaceMonitor.EventType.Initial:
            if (address !== null) {
                console.log(`Current address: ${address[addressFamily]}`);
            } else {
                console.log(`Network interface ${networkInterface} is inactive.`);
            }
            break;

        case NetworkInterfaceMonitor.EventType.IPChanged:
            console.log(`IP address changed: ${address[addressFamily]}`);
            break;

        case NetworkInterfaceMonitor.EventType.IPAssigned:
            console.log(`Network interface ${networkInterface} is now active.`);
            console.log(`IP address assigned: ${address[addressFamily]}`);
            break;

        case NetworkInterfaceMonitor.EventType.IPRemoved:
            console.log(`Network interface ${networkInterface} is now inactive.`);
            break;
    }
});
monitor.start();
monitor.stop();
```

