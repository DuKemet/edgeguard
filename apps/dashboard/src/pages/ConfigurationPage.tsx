import { useEffect, useState } from "react";
import type {
  DetectionSettings,
  RateLimitRule,
  RuleMatch,
} from "@edgeguard/shared";
import { api } from "../api/client";
import { useAuth } from "../hooks/useAuth";
import {
  Badge,
  EmptyState,
  ErrorBanner,
  LastUpdated,
  LoadingBlock,
  PageHeader,
  Panel,
} from "../components/ui";
import { usePolling } from "../hooks/usePolling";
import { formatDateTime, formatRelativeTime } from "../lib/format";

interface RuleDraft {
  id: string;
  name: string;
  endpoint: string;
  match: RuleMatch;
  limit: number;
  windowSeconds: number;
  burst: number;
  enabled: boolean;
}

const EMPTY_RULE: RuleDraft = {
  id: "",
  name: "",
  endpoint: "/api/",
  match: "prefix",
  limit: 30,
  windowSeconds: 10,
  burst: 10,
  enabled: true,
};

const NUMERIC_SETTINGS: Array<{
  key: keyof DetectionSettings;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
}> = [
  {
    key: "windowSeconds",
    label: "Detection window (s)",
    hint: "Rolling window used for request-rate counters.",
    min: 5,
    max: 300,
    step: 1,
  },
  {
    key: "clientRpsThreshold",
    label: "Client requests / second",
    hint: "Per-client rate that emits a high-client-rate event.",
    min: 0.1,
    max: 10_000,
    step: 0.1,
  },
  {
    key: "endpointRpsThreshold",
    label: "Endpoint requests / second",
    hint: "Per-endpoint rate that emits an endpoint-flood event.",
    min: 0.1,
    max: 100_000,
    step: 0.1,
  },
  {
    key: "trafficSpikeMultiplier",
    label: "Traffic spike multiplier",
    hint: "Platform traffic must exceed the previous window by this factor.",
    min: 1.1,
    max: 100,
    step: 0.1,
  },
  {
    key: "trafficSpikeMinRps",
    label: "Traffic spike floor (req/s)",
    hint: "Minimum platform rate before spike detection is considered.",
    min: 1,
    max: 100_000,
    step: 1,
  },
  {
    key: "violationThreshold",
    label: "Violations before isolation",
    hint: "Rate-limit denials within the violation window before isolating.",
    min: 1,
    max: 10_000,
    step: 1,
  },
  {
    key: "violationWindowSeconds",
    label: "Violation window (s)",
    hint: "Window used to count repeated rate-limit violations.",
    min: 5,
    max: 3_600,
    step: 1,
  },
  {
    key: "upstreamErrorRateThreshold",
    label: "Upstream error ratio",
    hint: "Error ratio (0–1) that emits an upstream spike event.",
    min: 0.01,
    max: 1,
    step: 0.01,
  },
  {
    key: "upstreamMinSamples",
    label: "Upstream minimum samples",
    hint: "Samples required before evaluating the upstream error ratio.",
    min: 1,
    max: 100_000,
    step: 1,
  },
  {
    key: "cooldownAbuseThreshold",
    label: "Cooldown abuse threshold",
    hint: "Requests an isolated client may send before an abuse event.",
    min: 1,
    max: 100_000,
    step: 1,
  },
  {
    key: "isolationSeconds",
    label: "Isolation duration (s)",
    hint: "How long an automatically isolated client stays blocked.",
    min: 5,
    max: 86_400,
    step: 1,
  },
  {
    key: "suppressionSeconds",
    label: "Event suppression (s)",
    hint: "Deduplication window for repeated findings of the same category.",
    min: 1,
    max: 3_600,
    step: 1,
  },
];

export function ConfigurationPage() {
  const { user } = useAuth();
  const canEdit = user?.role === "admin";
  const rules = usePolling(() => api.rules(), 5_000);
  const settings = usePolling(() => api.settings(), 5_000);
  const clients = usePolling(() => api.clients({ page: 1, pageSize: 20, windowMinutes: 60 }), 5_000);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(EMPTY_RULE);
  const [creating, setCreating] = useState(false);
  const [newRule, setNewRule] = useState<RuleDraft>(EMPTY_RULE);
  const [settingsDraft, setSettingsDraft] = useState<DetectionSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; message: string } | null>(null);

  useEffect(() => {
    if (settings.data && !settingsDraft) setSettingsDraft(settings.data.detection);
  }, [settings.data, settingsDraft]);

  const refreshAll = () => {
    rules.refresh();
    settings.refresh();
    clients.refresh();
  };

  const fail = (error: unknown) => {
    setNotice({
      tone: "danger",
      message: error instanceof Error ? error.message : "Request failed",
    });
  };

  const beginEdit = (rule: RateLimitRule) => {
    setEditingId(rule.id);
    setRuleDraft({ ...rule });
    setNotice(null);
  };

  const saveRule = async () => {
    if (!editingId) return;
    setBusy(true);
    try {
      await api.updateRule(editingId, {
        name: ruleDraft.name,
        endpoint: ruleDraft.endpoint,
        match: ruleDraft.match,
        limit: ruleDraft.limit,
        windowSeconds: ruleDraft.windowSeconds,
        burst: ruleDraft.burst,
        enabled: ruleDraft.enabled,
      });
      setNotice({ tone: "success", message: `Rule '${editingId}' updated.` });
      setEditingId(null);
      refreshAll();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const createRule = async () => {
    setBusy(true);
    try {
      await api.createRule(newRule);
      setNotice({ tone: "success", message: `Rule '${newRule.id}' created.` });
      setCreating(false);
      setNewRule(EMPTY_RULE);
      refreshAll();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const removeRule = async (id: string) => {
    if (!window.confirm(`Delete rate-limit rule '${id}'?`)) return;
    setBusy(true);
    try {
      await api.deleteRule(id);
      setNotice({ tone: "success", message: `Rule '${id}' deleted.` });
      refreshAll();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async () => {
    if (!settingsDraft) return;
    setBusy(true);
    try {
      await api.updateSettings(settingsDraft);
      setNotice({ tone: "success", message: "Detection settings saved." });
      settings.refresh();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const unblock = async (clientId: string) => {
    if (!window.confirm("Lift temporary isolation for this client?")) return;
    setBusy(true);
    try {
      await api.unblock(clientId);
      setNotice({ tone: "success", message: "Client isolation lifted." });
      clients.refresh();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const updateDraftSetting = <K extends keyof DetectionSettings>(key: K, value: DetectionSettings[K]) => {
    setSettingsDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  return (
    <>
      <PageHeader
        title="Configuration"
        subtitle="Rate-limit rules, detection thresholds and active isolations."
        actions={
          <div className="header-meta">
            {!canEdit ? <Badge tone="warning">viewer · read only</Badge> : null}
            <LastUpdated value={rules.lastUpdated} />
          </div>
        }
      />

      {notice ? (
        <div className={`notice tone-${notice.tone}`} role="status">
          {notice.message}
          <button type="button" className="notice-close" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}
      {rules.error ? <ErrorBanner error={rules.error} onRetry={rules.refresh} /> : null}
      {settings.error ? <ErrorBanner error={settings.error} onRetry={settings.refresh} /> : null}
      {clients.error ? <ErrorBanner error={clients.error} onRetry={clients.refresh} /> : null}

      <Panel
        title="Rate-limit rules"
        subtitle="Most specific enabled rule wins; the fallback rule catches unmatched paths."
        action={
          canEdit && !creating ? (
            <button type="button" className="button small" onClick={() => setCreating(true)}>
              New rule
            </button>
          ) : null
        }
      >
        {rules.loading && !rules.data ? (
          <LoadingBlock label="Loading rules" />
        ) : !rules.data ? null : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Endpoint</th>
                  <th className="numeric">Limit</th>
                  <th className="numeric">Window</th>
                  <th className="numeric">Burst</th>
                  <th>State</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rules.data.items.map((rule) =>
                  editingId === rule.id ? (
                    <tr key={rule.id} className="editing-row">
                      <td>
                        <input
                          className="input-compact"
                          value={ruleDraft.name}
                          onChange={(event) => setRuleDraft({ ...ruleDraft, name: event.target.value })}
                          aria-label="Rule name"
                        />
                        <span className="mono tiny muted">{rule.id}</span>
                      </td>
                      <td>
                        <input
                          className="input-compact"
                          value={ruleDraft.endpoint}
                          disabled={rule.id === "default"}
                          onChange={(event) => setRuleDraft({ ...ruleDraft, endpoint: event.target.value })}
                          aria-label="Rule endpoint"
                        />
                        <select
                          value={ruleDraft.match}
                          disabled={rule.id === "default"}
                          onChange={(event) =>
                            setRuleDraft({ ...ruleDraft, match: event.target.value as RuleMatch })
                          }
                          aria-label="Rule match type"
                        >
                          <option value="exact">exact</option>
                          <option value="prefix">prefix</option>
                        </select>
                      </td>
                      <td className="numeric">
                        <input
                          type="number"
                          className="input-compact numeric"
                          min={1}
                          value={ruleDraft.limit}
                          onChange={(event) => setRuleDraft({ ...ruleDraft, limit: Number(event.target.value) })}
                          aria-label="Rule limit"
                        />
                      </td>
                      <td className="numeric">
                        <input
                          type="number"
                          className="input-compact numeric"
                          min={1}
                          value={ruleDraft.windowSeconds}
                          onChange={(event) =>
                            setRuleDraft({ ...ruleDraft, windowSeconds: Number(event.target.value) })
                          }
                          aria-label="Rule window seconds"
                        />
                      </td>
                      <td className="numeric">
                        <input
                          type="number"
                          className="input-compact numeric"
                          min={0}
                          value={ruleDraft.burst}
                          onChange={(event) => setRuleDraft({ ...ruleDraft, burst: Number(event.target.value) })}
                          aria-label="Rule burst"
                        />
                      </td>
                      <td>
                        <label className="toggle">
                          <input
                            type="checkbox"
                            checked={ruleDraft.enabled}
                            disabled={rule.id === "default"}
                            onChange={(event) =>
                              setRuleDraft({ ...ruleDraft, enabled: event.target.checked })
                            }
                          />
                          <span>{ruleDraft.enabled ? "enabled" : "disabled"}</span>
                        </label>
                      </td>
                      <td className="row-actions">
                        <button type="button" className="button small" disabled={busy} onClick={saveRule}>
                          Save
                        </button>
                        <button
                          type="button"
                          className="button ghost small"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={rule.id}>
                      <td>
                        <strong>{rule.name}</strong>
                        <span className="mono tiny muted">{rule.id}</span>
                      </td>
                      <td>
                        <span className="mono small">{rule.endpoint}</span>
                        <Badge tone="neutral">{rule.match}</Badge>
                      </td>
                      <td className="numeric">{rule.limit}</td>
                      <td className="numeric">{rule.windowSeconds}s</td>
                      <td className="numeric">+{rule.burst}</td>
                      <td>
                        <Badge tone={rule.enabled ? "success" : "neutral"}>
                          {rule.enabled ? "enabled" : "disabled"}
                        </Badge>
                      </td>
                      <td className="row-actions">
                        {canEdit ? (
                          <>
                            <button type="button" className="button ghost small" onClick={() => beginEdit(rule)}>
                              Edit
                            </button>
                            {rule.id !== "default" ? (
                              <button
                                type="button"
                                className="button danger small"
                                disabled={busy}
                                onClick={() => removeRule(rule.id)}
                              >
                                Delete
                              </button>
                            ) : null}
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ),
                )}
                {creating && canEdit ? (
                  <tr className="editing-row">
                    <td>
                      <input
                        className="input-compact"
                        placeholder="rule-id"
                        value={newRule.id}
                        onChange={(event) => setNewRule({ ...newRule, id: event.target.value })}
                        aria-label="New rule id"
                      />
                      <input
                        className="input-compact"
                        placeholder="Rule name"
                        value={newRule.name}
                        onChange={(event) => setNewRule({ ...newRule, name: event.target.value })}
                        aria-label="New rule name"
                      />
                    </td>
                    <td>
                      <input
                        className="input-compact"
                        value={newRule.endpoint}
                        onChange={(event) => setNewRule({ ...newRule, endpoint: event.target.value })}
                        aria-label="New rule endpoint"
                      />
                      <select
                        value={newRule.match}
                        onChange={(event) =>
                          setNewRule({ ...newRule, match: event.target.value as RuleMatch })
                        }
                        aria-label="New rule match"
                      >
                        <option value="exact">exact</option>
                        <option value="prefix">prefix</option>
                      </select>
                    </td>
                    {(["limit", "windowSeconds", "burst"] as const).map((field) => (
                      <td key={field} className="numeric">
                        <input
                          type="number"
                          className="input-compact numeric"
                          min={field === "burst" ? 0 : 1}
                          value={newRule[field]}
                          onChange={(event) =>
                            setNewRule({ ...newRule, [field]: Number(event.target.value) })
                          }
                          aria-label={`New rule ${field}`}
                        />
                      </td>
                    ))}
                    <td>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={newRule.enabled}
                          onChange={(event) => setNewRule({ ...newRule, enabled: event.target.checked })}
                        />
                        <span>{newRule.enabled ? "enabled" : "disabled"}</span>
                      </label>
                    </td>
                    <td className="row-actions">
                      <button type="button" className="button small" disabled={busy} onClick={createRule}>
                        Create
                      </button>
                      <button
                        type="button"
                        className="button ghost small"
                        onClick={() => {
                          setCreating(false);
                          setNewRule(EMPTY_RULE);
                        }}
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Detection thresholds"
        subtitle="Runtime-tunable rules. Changes apply to new requests within seconds."
        action={
          canEdit && settingsDraft ? (
            <div className="row-actions">
              <button
                type="button"
                className="button ghost small"
                onClick={() => setSettingsDraft(settings.data?.detection ?? null)}
              >
                Reset
              </button>
              <button type="button" className="button small" disabled={busy} onClick={saveSettings}>
                Save thresholds
              </button>
            </div>
          ) : null
        }
      >
        {settings.loading && !settings.data ? (
          <LoadingBlock label="Loading detection settings" />
        ) : !settingsDraft ? null : (
          <div className="settings-grid">
            <div className="settings-toggles">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={settingsDraft.enabled}
                  disabled={!canEdit}
                  onChange={(event) => updateDraftSetting("enabled", event.target.checked)}
                />
                <span>Detection engine enabled</span>
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={settingsDraft.autoIsolate}
                  disabled={!canEdit}
                  onChange={(event) => updateDraftSetting("autoIsolate", event.target.checked)}
                />
                <span>Automatically isolate abusive clients</span>
              </label>
            </div>
            {NUMERIC_SETTINGS.map((setting) => (
              <label className="field" key={setting.key}>
                <span className="field-label">{setting.label}</span>
                <input
                  type="number"
                  value={Number(settingsDraft[setting.key])}
                  min={setting.min}
                  max={setting.max}
                  step={setting.step}
                  disabled={!canEdit}
                  onChange={(event) =>
                    updateDraftSetting(setting.key, Number(event.target.value) as never)
                  }
                />
                <span className="field-hint">{setting.hint}</span>
              </label>
            ))}
          </div>
        )}
        {settings.data ? (
          <p className="muted tiny">Settings last saved {formatDateTime(settings.data.updatedAt)}</p>
        ) : null}
      </Panel>

      <Panel title="Active isolations" subtitle="Temporary blocks created by detection or administrators">
        {clients.loading && !clients.data ? (
          <LoadingBlock label="Loading active isolations" />
        ) : !clients.data || clients.data.activeBlocks.length === 0 ? (
          <EmptyState title="No isolated clients" message="No client is currently in cooldown." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Category</th>
                  <th>Reason</th>
                  <th>Blocked</th>
                  <th>Expires</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {clients.data.activeBlocks.map((block) => (
                  <tr key={block.clientId}>
                    <td>
                      <span className="mono">{block.maskedIp}</span>
                      <span className="mono tiny muted">{block.clientId}</span>
                    </td>
                    <td>
                      <Badge tone="warning">{block.category}</Badge>
                    </td>
                    <td className="muted small">{block.reason}</td>
                    <td className="muted small">{formatDateTime(block.blockedAt)}</td>
                    <td>
                      <span className="small">{formatRelativeTime(block.expiresAt)}</span>
                      <span className="muted tiny">{block.remainingSeconds}s remaining</span>
                    </td>
                    <td className="row-actions">
                      {canEdit ? (
                        <button
                          type="button"
                          className="button small"
                          disabled={busy}
                          onClick={() => unblock(block.clientId)}
                        >
                          Unblock
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
