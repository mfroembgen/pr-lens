import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { DevicePage } from "./device"
import { SettingsPage } from "./settings"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.location.pathname === "/device" ? <DevicePage /> : window.location.pathname === "/settings" ? <SettingsPage /> : <App />}
  </StrictMode>,
)
