'use strict';

const os = require('os');

const ffi = require('ffi-napi');
const ref = require('ref-napi');

const { warning } = require('./print.js');

/** Event types that client can check for in notification callback. */
const EventType = {
    Initial: 0,
    IPChanged: 1,
    IPAssigned: 2,
    IPRemoved: 3,
};

/** ADDRESS_FAMILY used by NotifyIpInterfaceChange API. */
const AddressFamilyApiValue = {
    Any: 0,   // AF_UNSPEC
    IPv4: 2,  // AF_INET
    IPv6: 23, // AF_INET6
};

/** MIB_NOTIFICATION_TYPE in the callback from NotifyIpInterfaceChange API. */
const NotificationTypesApiValue = [
    'Parameter changed',
    'Interface added',
    'Interface removed',
    'Initial notification'
];

// Default parameters when using timer to detect real IP when link-local address is returned after being notified.
const DefaultCheckTimerInterval = 500;
const DefaultCheckTimerMaxTries = 20;

/** Define NotifyIpInterfaceChange and CancelMibChangeNotify2 Windows API. */
const NetworkInterfaceApi = ffi.Library('iphlpapi', {
    /*
    IPHLPAPI_DLL_LINKAGE _NETIOAPI_SUCCESS_ NETIOAPI_API NotifyIpInterfaceChange(
      [in]      ADDRESS_FAMILY               Family,
      [in]      PIPINTERFACE_CHANGE_CALLBACK Callback,
      [in]      PVOID                        CallerContext,
      [in]      BOOLEAN                      InitialNotification,
      [in, out] HANDLE                       *NotificationHandle
    );

    Windows Data Type:
      typedef BYTE BOOLEAN;
      typedef unsigned char BYTE;
      typedef PVOID HANDLE;
    */
    'NotifyIpInterfaceChange': [ 'int', [ 'int', 'pointer', 'pointer', 'int8', ref.refType('pointer') ] ],

    /*
    IPHLPAPI_DLL_LINKAGE NETIOAPI_API CancelMibChangeNotify2(
      [in] HANDLE NotificationHandle
    );
    */
    'CancelMibChangeNotify2': [ 'int', [ 'pointer' ] ]
});

/** Finalizer to ensure the underlying notification handle is closed. */
const finalizer = new FinalizationRegistry(monitorData => {
    if (monitorData.handle !== null) {
        warning(`NetworkInterfaceMonitor on "${monitorData.networkInterface}" for address family ${monitorData.addressFamily} is not properly stopped! You should call NetworkInterfaceMonitor.stop() to stop monitoring a network interface when it is no longer needed!`);
        NetworkInterfaceMonitor.cancelNotification(monitorData);
    }
});

class NetworkInterfaceMonitor {
    constructor(networkInterface, addressFamily, callback) {
        this.monitorData = {
            networkInterface: networkInterface,
            addressFamily: addressFamily,
            handle: null,
        };

        this.currentAddress = null;
        this.checkTimer = null;
        this.checkTimerCounter = 0;
        this.checkTimerInterval = DefaultCheckTimerInterval;
        this.checkTimerMaxTries = DefaultCheckTimerMaxTries;
        this.clientCallback = callback ?? null;

        // Define callback to NotifyIpInterfaceChange Windows API.
        this.callback = ffi.Callback('void', ['pointer', 'pointer', 'int'],
            (callerContext, row, notificationType) => {
                this.onNotifyIpInterfaceChange(callerContext, row, notificationType);
            }
        );

        // Register this monitor in finalizer so we can be alerted if it's not properly stopped.
        finalizer.register(this, this.monitorData);
    }

    /**
     * @return {object} Notification event types.
     */
    static get EventType() {
        return EventType;
    }

    /**
     * Interval for using timer to detect real IP when link-local address is returned after being notified.
     * @param {integer} interval - The interval to be used, in milliseconds.
     */
    set ipCheckTimerInterval(interval) {
        this.checkTimerInterval = interval;
    }

    /**
     * Max number of tries for using timer to detect real IP when link-local address is returned after being notified.
     * @param {integer} maxTries - The max number of tries.
     */
    set ipCheckTimerMaxTries(maxTries) {
        this.checkTimerMaxTries = maxTries;
    }

    /**
     * Starts monitoring.
     * Note: make sure to call stop() when the network interface is no longer needed to be monitored. Otherwise the finalizer will complain (though, the finalizer will still properly stop the monitor).
     * @return {boolean} Whether the monitor is started. Note: the monitor may have already been started previously, in which case this method still returns true.
     */
    start() {
        if (this.monitorData.handle !== null) {
            // Already started
            return true;
        }

        // Get current IP address, allowing link-local address to be returned.
        const { address, hasLinkLocalAddress } = this.getIP(true);
        this.currentAddress = address;
        if (this.clientCallback) {
            // Send initial callback for current IP address
            this.clientCallback(this.currentAddress, EventType.Initial);
        }

        // callerContext is not used by this class.
        this.callerContext = ref.alloc('pointer');

        // Handle returned by NotifyIpInterfaceChange, which can be used to cancel the registration.
        this.monitorData.handle = ref.alloc('pointer');
        return (NetworkInterfaceApi.NotifyIpInterfaceChange(AddressFamilyApiValue[this.monitorData.addressFamily], this.callback, this.callerContext, 0, this.monitorData.handle) === 0);
    }

    /**
     * Stops monitoring.
     * @return {boolean} Whether the monitor is stopped. Note: the monitor may have already been stopped previously, in which case this method still returns true.
     */
    stop() {
        this.clientCallback = null;
        return NetworkInterfaceMonitor.cancelNotification(this.monitorData);
    }

    /** Private static method: cancels registered notification. */
    static cancelNotification(monitorData) {
        if (monitorData.handle !== null && NetworkInterfaceApi.CancelMibChangeNotify2(monitorData.handle.deref()) === 0) {
            monitorData.handle = null;
        }

        return (monitorData.handle === null);
    }

    /** Private method: handles callback from NotifyIpInterfaceChange. */
    onNotifyIpInterfaceChange(callerContext, row, notificationType) {
        this.detectIPChange();
    }

    /** Private method: Timer callback to detect real IP when link-local address is returned after being notified. */
    onCheckTimer() {
        this.checkTimer = null;
        if (this.checkTimerCounter++ < this.checkTimerMaxTries) {
            this.detectIPChange();
        } else {
            // It has been quite a long time without IP assignment. Stop trying.
            this.checkTimerCounter = 0;
        }
    }

    /**
     * Private method: detects IP change on monitored network interface, if any.
     * Note, if link-local address is currently assigned, empty IP address will be sent to client in notification callback. A check timer is running
     * in this case to detect real IP assignment. Client will be notified of real IP either when NotifyIpInterfaceChange notifies the change (which
     * may not be reliable), or when real IP is detected in Timer callback.
     */
    detectIPChange() {
        // Get new IP address, ignoring link-local address.
        const { address, hasLinkLocalAddress } = this.getIP();
        let eventType = EventType.Initial;
        if (address !== null) {
            if (this.currentAddress === null) {
                eventType = EventType.IPAssigned;
            } else {
                for (const family in address) {
                    if (this.currentAddress[family] !== address[family]) {
                        eventType = EventType.IPChanged;
                    }
                }
            }

            if (this.checkTimer !== null) {
                // Cancel the check timer since new IP assignment event is fired.
                clearTimeout(this.checkTimer);
                this.checkTimer = null;
                this.checkTimerCounter = 0;
            }
        } else {
            if (this.currentAddress !== null) {
                eventType = EventType.IPRemoved;
            } else if (hasLinkLocalAddress[this.monitorData.addressFamily] && this.checkTimer === null) {
                // IP assignment changed from none to link-local address, likely real IP will be assigned. In theory a new notification will come when real IP is assigned,
                // but this doesn't seem to always fire. So, use a timer to help this detection. It will be canceled if the event actually fires.
                this.checkTimer = setTimeout(() => {
                    this.onCheckTimer();
                }, this.checkTimerInterval);
            }
        }

        this.currentAddress = address;
        if (eventType !== EventType.Initial && this.clientCallback) {
            this.clientCallback(this.currentAddress, eventType);
        }
    }

    /**
     * Retrieves current IP address on the monitored network interface for the specified address family.
     * @param {boolean} allowLinkLocalAddress - (Optional) Whether link-local address can be returned as current address, if assigned.
     *                                          If not provided, default value false is used.
     * @return {Object} Current address if assigned, and flags to indicate whether link-local address is currently assigned.
     */
    getIP(allowLinkLocalAddress = false) {
        const networkInterfaces = os.networkInterfaces();
        const hasLinkLocalAddress = {
            IPv4: false,
            IPv6: false,
        };
        const result = {};

        if (networkInterfaces && networkInterfaces[this.monitorData.networkInterface]) {
            for (const ip of networkInterfaces[this.monitorData.networkInterface]) {
                if (this.monitorData.addressFamily === ip.family || this.monitorData.addressFamily === 'Any') {
                    if (!this.isLinkLocalAddress(ip.address, ip.family)) {
                        result[ip.family] = ip.address;
                    } else {
                        hasLinkLocalAddress[ip.family] = true;
                        if (allowLinkLocalAddress) {
                            result[ip.family] = ip.address;
                        }
                    }
                }
            }
        }

        return {
            address: (Object.keys(result).length > 0 ? result : null),
            hasLinkLocalAddress : hasLinkLocalAddress,
        }
    }

    /**
     * Checks if an IP address in the specified address family is a link-local address.
     * @param {string} address - IP address to be checked.
     * @param {string} addressFamily - Address family of the provided IP address.
     * @return {boolean} Whether the IP address is link-local address.
     */
    isLinkLocalAddress(address, addressFamily) {
        if (addressFamily === 'IPv4') {
            return address && address.startsWith('169.254'); // IPv4 link-local address block is 169.254.0.0/16
        } else if (addressFamily === 'IPv6') {
            return address && (address.startsWith('fe8') || address.startsWith('fe9') || address.startsWith('fea') || address.startsWith('feb')); // IPv6 link-local address block is fe80::/10
        }
        return false;
    }
}

module.exports = NetworkInterfaceMonitor;
