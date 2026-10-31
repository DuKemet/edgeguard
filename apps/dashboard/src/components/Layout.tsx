import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

const NAV_ITEMS = [
  { to: "/", label: "Overview", short: "OV", end: true },
  { to: "/traffic", label: "Traffic", short: "TR", end: false },
  { to: "/events", label: "Events", short: "EV", end: false },
  { to: "/configuration", label: "Configuration", short: "CF", end: false },
];

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            EG
          </span>
          <span className="brand-copy">
            <strong>EdgeGuard</strong>
            <small>API protection</small>
          </span>
        </div>
        <nav className="nav" aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
            >
              <span className="nav-short" aria-hidden="true">
                {item.short}
              </span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="user-chip">
            <span className="user-avatar" aria-hidden="true">
              {(user?.username ?? "?").slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>{user?.username ?? "unknown"}</strong>
              <small className="role-tag">{user?.role ?? "viewer"}</small>
            </span>
          </div>
          <button type="button" className="button ghost small" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="main-column">
        <header className="mobile-header">
          <div className="brand compact">
            <span className="brand-mark" aria-hidden="true">
              EG
            </span>
            <strong>EdgeGuard</strong>
          </div>
          <button type="button" className="button ghost small" onClick={handleLogout}>
            Sign out
          </button>
        </header>
        <nav className="mobile-nav" aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `mobile-nav-link${isActive ? " active" : ""}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <main className="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
