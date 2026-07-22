import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime } from "./realtime";

const ORDERS_KEY = "jibe-jets-stadium-orders-v2";
const MUTATIONS_KEY = "jibe-jets-stadium-orders-mutations-v2";
const ORDERS_API_URL = "https://ny-jets-retail-orders-v2.vercel.app/api/orders";
const REALTIME_CHANNEL = "stadium-orders-v2";
const SAFETY_SYNC_INTERVAL_MS = 60_000;
const HIDDEN_SYNC_INTERVAL_MS = 300_000;
const REQUEST_TIMEOUT_MS = 10000;

export type StadiumOrderService = "concierge" | "suite";
export type StadiumOrderStatus = "new" | "preparing" | "ready" | "out-for-delivery" | "fulfilled";
export type StadiumOrdersLinkStatus = "connecting" | "live" | "reconnecting" | "offline";

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

type PendingMutation = {
  id: string;
  kind: "upsert";
  order: StadiumOrder;
} | {
  id: string;
  kind: "delete";
  orderId: string;
};

type OrderChange = {
  kind: "upsert" | "delete";
  orderId: string;
  order?: unknown;
  recordedAt: string;
};

function isStadiumOrder(value: unknown): value is StadiumOrder {
  if (!value || typeof value !== "object") return false;
  const order = value as Partial<StadiumOrder>;

  return order.version === 1
    && typeof order.id === "string"
    && typeof order.reference === "string"
    && typeof order.createdAt === "string"
    && typeof order.updatedAt === "string"
    && typeof order.kioskId === "string"
    && (order.service === "concierge" || order.service === "suite")
    && ["new", "preparing", "ready", "out-for-delivery", "fulfilled"].includes(order.status ?? "")
    && Boolean(order.customer && typeof order.customer.name === "string" && typeof order.customer.phone === "string")
    && Boolean(order.fulfillment
      && typeof order.fulfillment.location === "string"
      && typeof order.fulfillment.instructions === "string")
    && Array.isArray(order.items)
    && order.items.length > 0
    && typeof order.itemCount === "number"
    && typeof order.subtotal === "number"
    && typeof order.tax === "number"
    && typeof order.total === "number";
}

function isOrderChange(value: unknown): value is OrderChange {
  if (!value || typeof value !== "object") return false;
  const change = value as Partial<OrderChange>;
  return (change.kind === "upsert" || change.kind === "delete")
    && typeof change.orderId === "string"
    && typeof change.recordedAt === "string";
}

function newestFirst(left: StadiumOrder, right: StadiumOrder) {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt);
}

function readStoredOrders() {
  try {
    const value = window.localStorage.getItem(ORDERS_KEY);
    const parsed: unknown = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.filter(isStadiumOrder) : [];
  } catch {
    return [];
  }
}

function writeStoredOrders(orders: StadiumOrder[]) {
  try {
    window.localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
  } catch {
    // The live queue remains usable if browser storage is unavailable.
  }
}

function isPendingMutation(value: unknown): value is PendingMutation {
  if (!value || typeof value !== "object") return false;
  const mutation = value as Partial<PendingMutation>;
  if (typeof mutation.id !== "string") return false;
  if (mutation.kind === "upsert") return isStadiumOrder(mutation.order);
  return mutation.kind === "delete" && typeof mutation.orderId === "string";
}

function readPendingMutations() {
  try {
    const value = window.localStorage.getItem(MUTATIONS_KEY);
    const parsed: unknown = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.filter(isPendingMutation) : [];
  } catch {
    return [];
  }
}

function writePendingMutations(mutations: PendingMutation[]) {
  try {
    window.localStorage.setItem(MUTATIONS_KEY, JSON.stringify(mutations));
  } catch {
    // A later page refresh will recover the last confirmed server state.
  }
}

function queueMutation(mutation: PendingMutation) {
  const pending = readPendingMutations().filter((item) => item.id !== mutation.id);
  pending.push(mutation);
  writePendingMutations(pending);
}

function removeMutation(mutationId: string) {
  writePendingMutations(readPendingMutations().filter((mutation) => mutation.id !== mutationId));
}

async function requestOrdersApi(init: RequestInit = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(ORDERS_API_URL, {
      ...init,
      headers: {
        Accept: "application/json",
        ...init.headers,
      },
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function fetchRemoteOrders() {
  const response = await requestOrdersApi();
  if (!response.ok) throw new Error(`Order sync failed with status ${response.status}`);

  const payload: unknown = await response.json();
  const remoteOrders = payload && typeof payload === "object" && "orders" in payload
    ? (payload as { orders: unknown }).orders
    : [];

  if (!Array.isArray(remoteOrders)) throw new Error("Order service returned an invalid response");
  return remoteOrders.filter(isStadiumOrder);
}

async function upsertRemoteOrder(order: StadiumOrder) {
  const response = await requestOrdersApi({
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  });

  if (!response.ok && response.status !== 410) {
    throw new Error(`Order update failed with status ${response.status}`);
  }
}

async function deleteRemoteOrder(orderId: string) {
  const response = await requestOrdersApi({
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId }),
  });

  if (!response.ok) throw new Error(`Order deletion failed with status ${response.status}`);
}

async function flushPendingMutations() {
  for (const mutation of readPendingMutations()) {
    if (mutation.kind === "delete") await deleteRemoteOrder(mutation.orderId);
    else await upsertRemoteOrder(mutation.order);
    removeMutation(mutation.id);
  }
}

export function useStadiumOrders() {
  const [orders, setOrders] = useState<StadiumOrder[]>(readStoredOrders);
  const [linkStatus, setLinkStatus] = useState<StadiumOrdersLinkStatus>("connecting");
  const [lastReceivedOrderId, setLastReceivedOrderId] = useState("");
  const ordersRef = useRef(orders);
  const knownOrderIdsRef = useRef(new Set(orders.map((order) => order.id)));
  const requestSyncRef = useRef<() => void>(() => undefined);

  const replaceOrders = useCallback((nextOrders: StadiumOrder[]) => {
    ordersRef.current = nextOrders;
    writeStoredOrders(nextOrders);
    setOrders(nextOrders);
  }, []);

  const applyRemoteChange = useCallback((change: OrderChange) => {
    if (change.kind === "delete") {
      knownOrderIdsRef.current.delete(change.orderId);
      replaceOrders(ordersRef.current.filter((order) => order.id !== change.orderId));
      setLinkStatus("live");
      return;
    }

    if (!isStadiumOrder(change.order)) return;
    const incomingOrder = change.order;
    const currentOrder = ordersRef.current.find((order) => order.id === incomingOrder.id);
    if (currentOrder && Date.parse(currentOrder.updatedAt) > Date.parse(incomingOrder.updatedAt)) return;

    const isNewOrder = !knownOrderIdsRef.current.has(incomingOrder.id);
    const nextOrders = currentOrder
      ? ordersRef.current.map((order) => order.id === incomingOrder.id ? incomingOrder : order)
      : [incomingOrder, ...ordersRef.current];

    knownOrderIdsRef.current.add(incomingOrder.id);
    replaceOrders(nextOrders.sort(newestFirst));
    if (isNewOrder) setLastReceivedOrderId(incomingOrder.id);
    setLinkStatus("live");
  }, [replaceOrders]);

  const { status: realtimeStatus } = useRealtime({
    channels: [REALTIME_CHANNEL],
    events: ["orders.changed"],
    onData: ({ data }) => {
      if (isOrderChange(data)) applyRemoteChange(data);
    },
  });

  useEffect(() => {
    if (!navigator.onLine) {
      setLinkStatus("offline");
      return;
    }
    if (realtimeStatus === "connected") setLinkStatus("live");
    else if (realtimeStatus === "connecting") setLinkStatus("connecting");
    else setLinkStatus("reconnecting");
  }, [realtimeStatus]);

  useEffect(() => {
    let stopped = false;
    let syncing = false;
    let syncAgain = false;
    let migrationComplete = false;
    let pollTimer = 0;

    const scheduleSync = (delay: number) => {
      window.clearTimeout(pollTimer);
      if (stopped) return;
      pollTimer = window.setTimeout(() => void syncOrders(), delay);
    };

    const syncOrders = async () => {
      if (stopped) return;
      if (syncing) {
        syncAgain = true;
        return;
      }
      if (!navigator.onLine) {
        setLinkStatus("offline");
        scheduleSync(SAFETY_SYNC_INTERVAL_MS);
        return;
      }

      syncing = true;
      try {
        if (!migrationComplete) {
          for (const order of ordersRef.current) queueMutation({ id: order.id, kind: "upsert", order });
          migrationComplete = true;
        }

        await flushPendingMutations();
        const remoteOrders = await fetchRemoteOrders();
        if (stopped) return;

        const newOrder = remoteOrders.find((order) => !knownOrderIdsRef.current.has(order.id));
        knownOrderIdsRef.current = new Set(remoteOrders.map((order) => order.id));
        replaceOrders(remoteOrders);
        if (newOrder) setLastReceivedOrderId(newOrder.id);
        setLinkStatus("live");
      } catch {
        if (!stopped) setLinkStatus(navigator.onLine ? "reconnecting" : "offline");
      } finally {
        syncing = false;
        const fallbackDelay = document.visibilityState === "visible"
          ? SAFETY_SYNC_INTERVAL_MS
          : HIDDEN_SYNC_INTERVAL_MS;
        const delay = syncAgain ? 0 : fallbackDelay;
        syncAgain = false;
        scheduleSync(delay);
      }
    };

    requestSyncRef.current = () => scheduleSync(0);

    const reconnect = () => {
      setLinkStatus("connecting");
      scheduleSync(0);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") scheduleSync(0);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === MUTATIONS_KEY) scheduleSync(0);
    };

    void syncOrders();
    window.addEventListener("online", reconnect);
    window.addEventListener("offline", reconnect);
    window.addEventListener("storage", handleStorage);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stopped = true;
      window.clearTimeout(pollTimer);
      requestSyncRef.current = () => undefined;
      window.removeEventListener("online", reconnect);
      window.removeEventListener("offline", reconnect);
      window.removeEventListener("storage", handleStorage);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [replaceOrders]);

  const updateOrderStatus = useCallback((orderId: string, status: StadiumOrderStatus) => {
    const target = ordersRef.current.find((order) => order.id === orderId);
    if (!target || target.status === status) return;

    const updatedOrder = { ...target, status, updatedAt: new Date().toISOString() };
    const nextOrders = ordersRef.current.map((order) => order.id === orderId ? updatedOrder : order);
    replaceOrders(nextOrders);
    queueMutation({ id: orderId, kind: "upsert", order: updatedOrder });
    requestSyncRef.current();
  }, [replaceOrders]);

  const deleteOrder = useCallback((orderId: string) => {
    replaceOrders(ordersRef.current.filter((order) => order.id !== orderId));
    knownOrderIdsRef.current.delete(orderId);
    queueMutation({ id: orderId, kind: "delete", orderId });
    requestSyncRef.current();
  }, [replaceOrders]);

  return {
    orders,
    linkStatus,
    lastReceivedOrderId,
    updateOrderStatus,
    deleteOrder,
  };
}
