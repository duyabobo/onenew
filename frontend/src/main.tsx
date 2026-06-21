import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import ChatPage from "./pages/ChatPage";
import AdminPage from "./pages/AdminPage";
import "./index.css";

function Layout() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-6 shadow-sm">
        <span className="font-bold text-lg text-indigo-600">Pi Agent</span>
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `text-sm font-medium px-3 py-1 rounded-md transition-colors ${
              isActive ? "bg-indigo-50 text-indigo-700" : "text-gray-600 hover:text-gray-900"
            }`
          }
        >
          对话
        </NavLink>
        <NavLink
          to="/admin"
          className={({ isActive }) =>
            `text-sm font-medium px-3 py-1 rounded-md transition-colors ${
              isActive ? "bg-indigo-50 text-indigo-700" : "text-gray-600 hover:text-gray-900"
            }`
          }
        >
          管理
        </NavLink>
      </nav>
      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/admin" element={<AdminPage />} />
        </Routes>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  </React.StrictMode>
);
