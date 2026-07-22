
  import { RealtimeProvider } from "@upstash/realtime/client";
  import { createRoot } from "react-dom/client";
  import App from "./app/App.tsx";
  import "./styles/index.css";

  createRoot(document.getElementById("root")!).render(
    <RealtimeProvider
      api={{ url: "https://ny-jets-retail-orders-v2.vercel.app/api/realtime" }}
      maxReconnectAttempts={20}
    >
      <App />
    </RealtimeProvider>,
  );
