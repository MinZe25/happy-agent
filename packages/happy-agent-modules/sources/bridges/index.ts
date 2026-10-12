export {
    BridgeError,
    bridgeEventListenerSchema,
    bridgeNameSchema,
    portBridgeRequestSchema,
    usbBridgeRequestSchema,
    MAX_PORT_BRIDGE_CONNECTIONS,
    MAX_PORT_BRIDGE_WAITING_CONNECTIONS,
    MAX_PORT_BRIDGES,
    MAX_PORT_BRIDGES_PER_WORKSPACE,
    MAX_USB_BRIDGES,
    PORT_BRIDGE_ACCEPT_TIMEOUT_MS,
    USB_IMPORT_TIMEOUT_MS,
    type BridgeAdmission,
    type BridgeEnding,
    type BridgeErrorCode,
    type BridgeEvent,
    type BridgeEventListener,
    type BridgeWebSocket,
    type BridgeWebSocketBinding,
    type PortBridgeRequest,
    type UsbBridgeRequest,
} from "./Bridge.js";
export { BridgesModule } from "./BridgesModule.js";
export { UsbAttachError, type AttachedUsbDevice } from "./impl/attachVhciDevice.js";
export type { UsbMachineProbe } from "./impl/probeUsbMachine.js";
export type { UsbHostController } from "./impl/UsbHostController.js";
