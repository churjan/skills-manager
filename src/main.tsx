import { createRoot } from "react-dom/client"
import { TooltipProvider } from "./components/ui/tooltip"
import { App } from "./App"
import "./index.css"

createRoot(document.getElementById("root")!).render(<TooltipProvider delay={250}><App /></TooltipProvider>)
