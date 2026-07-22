import { createRealtime } from "@upstash/realtime/client";

type DashboardRealtimeEvents = {
  orders: {
    changed: {
      kind: "upsert" | "delete";
      orderId: string;
      order?: unknown;
      recordedAt: string;
    };
  };
};

export const { useRealtime } = createRealtime<DashboardRealtimeEvents>();
