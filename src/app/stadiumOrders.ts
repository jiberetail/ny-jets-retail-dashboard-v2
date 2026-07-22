import { useCallback, useEffect, useState } from "react";
import { Peer, type DataConnection } from "peerjs";

export const STADIUM_ORDERS_CHANNEL = "jets-stadium-orders-v2";
export const STADIUM_ORDERS_DASHBOARD_PEER_ID = "jibe-jets-stadium-orders-v2";

const ORDERS_KEY = "jibe-jets-stadium-orders-v2";

export type StadiumOrderService = "concierge" | "suite";
export type StadiumOrderStatus = "new" | "preparing" | "ready" | "out-for-delivery" | "fulfilled";
export type StadiumOrdersLinkStatus = "connecting" | "live" | "reconnecting" | "conflict" | "offline";

export type StadiumOrderItem = {
  id: string;
  name: string;
  image: string;
  size: string;
  quantity: number;
  unitPrice: number;
};

export type StadiumOrder = {
  version: 1;
  id: string;
  reference: string;
  createdAt: string;
  updatedAt: string;
  kioskId: string;
  service: StadiumOrderService;
  status: StadiumOrderStatus;
  customer: {
    name: string;
    phone: string;
  };
  fulfillment: {
    location: string;
    instructions: string;
  };
  items: StadiumOrderItem[];
  itemCount: number;
  subtotal: number;
  tax: number;
  total: number;
};

type StadiumOrderCreatedMessage = {
  type: "stadium-order-created";
  channel: typeof STADIUM_ORDERS_CHANNEL;
  order: StadiumOrder;
};

function readStoredOrders() {
  try {
    const value = window.localStorage.getItem(ORDERS_KEY);
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.filter(isStadiumOrder) : [];
  } catch {
    return [];
  }
}

function isStadiumOrder(value: unknown): value is StadiumOrder {
  if (!value || typeof value !== "object") return false;
  const order = value as Partial<StadiumOrder>;

  return order.version === 1
    && typeof order.id === "string"
    && typeof order.reference === "string"
    && typeof order.createdAt === "string"
    && (order.service === "concierge" || order.service === "suite")
    && ["new", "preparing", "ready", "out-for-delivery", "fulfilled"].includes(order.status ?? "")
    && Boolean(order.customer && typeof order.customer.name === "string" && typeof order.customer.phone === "string")
    && Boolean(order.fulfillment && typeof order.fulfillment.location === "string")
    && Array.isArray(order.items)
    && typeof order.total === "number";
}

function isCreatedMessage(value: unknown): value is StadiumOrderCreatedMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<StadiumOrderCreatedMessage>;
  return message.type === "stadium-order-created"
    && message.channel === STADIUM_ORDERS_CHANNEL
    && isStadiumOrder(message.order);
}

export function useStadiumOrders() {
  const [orders, setOrders] = useState<StadiumOrder[]>(readStoredOrders);
  const [linkStatus, setLinkStatus] = useState<StadiumOrdersLinkStatus>("connecting");
  const [lastReceivedOrderId, setLastReceivedOrderId] = useState("");

  useEffect(() => {
    try {
      window.localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
    } catch {
      // Keep the active operations queue usable even if storage is unavailable.
    }
  }, [orders]);

  useEffect(() => {
    let peer: Peer | null = null;
    let reconnectTimer = 0;
    let stopped = false;

    const receiveConnection = (connection: DataConnection) => {
      if (connection.metadata?.channel !== STADIUM_ORDERS_CHANNEL) {
        connection.close();
        return;
      }

      connection.on("data", (message) => {
        if (!isCreatedMessage(message)) return;
        const incoming = message.order;

        setOrders((current) => {
          const existing = current.find((order) => order.id === incoming.id);
          if (existing) {
            return current.map((order) => order.id === incoming.id
              ? { ...incoming, status: order.status, updatedAt: order.updatedAt }
              : order);
          }
          return [incoming, ...current];
        });
        setLastReceivedOrderId(incoming.id);
        connection.send({
          type: "stadium-order-accepted",
          channel: STADIUM_ORDERS_CHANNEL,
          orderId: incoming.id,
        });
      });
    };

    const connect = () => {
      if (stopped) return;
      setLinkStatus("connecting");
      peer = new Peer(STADIUM_ORDERS_DASHBOARD_PEER_ID, { debug: 1 });

      peer.on("open", () => setLinkStatus("live"));
      peer.on("connection", receiveConnection);
      peer.on("disconnected", () => {
        if (stopped) return;
        setLinkStatus("reconnecting");
        peer?.destroy();
        reconnectTimer = window.setTimeout(connect, 3500);
      });
      peer.on("error", (error) => {
        if (stopped) return;
        if (error.type === "unavailable-id") {
          setLinkStatus("conflict");
          return;
        }
        setLinkStatus("offline");
        peer?.destroy();
        reconnectTimer = window.setTimeout(connect, 5000);
      });
    };

    const syncStoredOrders = (event: StorageEvent) => {
      if (event.key === ORDERS_KEY) setOrders(readStoredOrders());
    };

    connect();
    window.addEventListener("storage", syncStoredOrders);

    return () => {
      stopped = true;
      window.clearTimeout(reconnectTimer);
      window.removeEventListener("storage", syncStoredOrders);
      peer?.destroy();
    };
  }, []);

  const updateOrderStatus = useCallback((orderId: string, status: StadiumOrderStatus) => {
    const updatedAt = new Date().toISOString();
    setOrders((current) => current.map((order) => order.id === orderId ? { ...order, status, updatedAt } : order));
  }, []);

  const deleteOrder = useCallback((orderId: string) => {
    setOrders((current) => current.filter((order) => order.id !== orderId));
  }, []);

  return {
    orders,
    linkStatus,
    lastReceivedOrderId,
    updateOrderStatus,
    deleteOrder,
  };
}
