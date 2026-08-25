import { useAppState } from "./hooks/useAppState";
import { Dashboard } from "./components/Dashboard";
import { LlmChat } from "./components/LlmChat";
import { TaskPage } from "./components/TaskPage";
import { Library, History } from "./components/Library";
import { Diagnostics, Recovery } from "./components/Diagnostics";
import { Settings } from "./components/Settings";
import { ApprovalModal, Toast, NavPlaceholder } from "./components/Common";
import "./styles.css";

export function App() {
  const state = useAppState();
  const { page, routeBack } = state;

  const renderPage = () => {
    let content: React.ReactNode;
    switch (page) {
      case "dashboard": content = <Dashboard {...state} />; break;
      case "llm": content = <LlmChat {...state} />; break;
      case "task": content = <TaskPage {...state} />; break;
      case "library": content = <Library {...state} />; break;
      case "history": content = <History {...state} />; break;
      case "diagnostics": content = <Diagnostics {...state} />; break;
      case "settings": content = <Settings {...state} />; break;
      case "recovery": content = <Recovery {...state} />; break;
      default: content = <Dashboard {...state} />;
    }
    return content;
  };

  return (
    <div className="app-shell studio-shell">
      <NavPlaceholder />
      <main className="main">
        {renderPage()}
      </main>
      <ApprovalModal state={state} />
      <Toast state={state} />
    </div>
  );
}
