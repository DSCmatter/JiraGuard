import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@forge/bridge";

const SETUP_HINT = "Create an agent, then connect a client.";
const NO_MATCH_HINT = "No events match this filter.";
const ENDPOINT_UNAVAILABLE = "The endpoint URL is not available yet.";
const TABS = ["Agents", "Approvals", "Audit"];

function projectKeys(value) {
  return value.split(/[\s,]+/).filter((key) => key !== "");
}

function asDay(value) {
  const day = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

function auditHint(empty) {
  if (empty === "setup") {
    return SETUP_HINT;
  }
  if (empty === "no-match") {
    return NO_MATCH_HINT;
  }
  return null;
}

// JSON.stringify returns undefined for undefined, which React refuses to render inside a cell.
function literal(value) {
  const text = JSON.stringify(value);
  return text === undefined ? "null" : text;
}

function tabId(label) {
  return `jiraguard-tab-${label.toLowerCase()}`;
}

export default function App() {
  const pending = useRef(false);
  const tabRefs = useRef([]);
  const [tab, setTab] = useState(0);
  const [locked, setLocked] = useState(false);
  const [desk, setDesk] = useState(null);
  const [token, setToken] = useState(null);
  const [notice, setNotice] = useState(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [projects, setProjects] = useState("");
  const [tools, setTools] = useState(["guard_whoami"]);
  const [writeMode, setWriteMode] = useState("approve");
  const [auditAgent, setAuditAgent] = useState("");
  const [auditOutcome, setAuditOutcome] = useState("");
  const [auditFrom, setAuditFrom] = useState("");
  const [auditTo, setAuditTo] = useState("");
  const [auditInjection, setAuditInjection] = useState(false);

  const accept = useCallback((result) => {
    if (!result || typeof result !== "object") {
      setNotice("That action is not available.");
      return;
    }
    if (result.type === "created") {
      setToken(result.token);
      setDesk(result.desk);
      setNotice(null);
      return;
    }
    if (result.type === "desk") {
      setDesk(result.desk);
      setNotice(null);
      return;
    }
    if (result.type === "rejected") {
      setNotice(typeof result.reason === "string" ? result.reason : "That action is not available.");
      if (result.desk) {
        setDesk(result.desk);
      }
      return;
    }
    setNotice("That action is not available.");
  }, []);

  const run = useCallback(
    async (command) => {
      if (pending.current) {
        return;
      }
      pending.current = true;
      setLocked(true);
      try {
        const result = await invoke("run", command);
        accept(result);
      } catch {
        setNotice("The page could not reach JiraGuard.");
      } finally {
        pending.current = false;
        setLocked(false);
      }
    },
    [accept],
  );

  useEffect(() => {
    void run({ type: "open" });
  }, [run]);

  function toggleTool(tool, checked) {
    setTools((current) => (checked ? [...new Set([...current, tool])] : current.filter((item) => item !== tool)));
  }

  function createAgent() {
    void run({
      type: "createAgent",
      name,
      description,
      allowedProjects: projectKeys(projects),
      allowedTools: tools,
      writeMode,
    });
  }

  function filterAudit() {
    const filter = {};
    if (auditAgent !== "") {
      filter.agentId = auditAgent;
    }
    if (auditOutcome !== "") {
      filter.outcome = auditOutcome;
    }
    if (auditFrom !== "") {
      filter.from = auditFrom;
    }
    if (auditTo !== "") {
      filter.to = auditTo;
    }
    if (auditInjection) {
      filter.injectionFlagged = true;
    }
    void run({ type: "filterAudit", filter });
  }

  function clearAudit() {
    setAuditAgent("");
    setAuditOutcome("");
    setAuditFrom("");
    setAuditTo("");
    setAuditInjection(false);
    void run({ type: "filterAudit", filter: {} });
  }

  function onTabKey(event, index) {
    let next = null;
    if (event.key === "ArrowRight") {
      next = (index + 1) % TABS.length;
    } else if (event.key === "ArrowLeft") {
      next = (index + TABS.length - 1) % TABS.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = TABS.length - 1;
    }
    if (next === null) {
      return;
    }
    event.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  }

  const hint = desk ? auditHint(desk.audit.empty) : null;

  return (
    <div className="page" aria-busy={locked}>
      <h1 className="page-title">JiraGuard</h1>
      {notice ? (
        <p className="notice notice-error" role="alert">
          {notice}
        </p>
      ) : null}
      {token ? (
        <section className="notice notice-success" aria-labelledby="token-heading">
          <div className="notice-head">
            <h2 className="notice-title" id="token-heading">
              Copy this token now. It is shown once.
            </h2>
            <button type="button" className="button button-subtle" onClick={() => setToken(null)}>
              Dismiss
            </button>
          </div>
          <label className="label" htmlFor="agent-token">
            Token
          </label>
          <input className="textfield textfield-code" id="agent-token" value={token} readOnly />
        </section>
      ) : null}
      {desk ? (
        <div className="tabs">
          <div className="tablist" role="tablist" aria-label="JiraGuard sections">
            {TABS.map((label, index) => (
              <button
                key={label}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                type="button"
                role="tab"
                id={tabId(label)}
                className={index === tab ? "tab tab-active" : "tab"}
                aria-selected={index === tab}
                aria-controls="jiraguard-panel"
                tabIndex={index === tab ? 0 : -1}
                onClick={() => setTab(index)}
                onKeyDown={(event) => onTabKey(event, index)}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            className="panel"
            id="jiraguard-panel"
            role="tabpanel"
            aria-labelledby={tabId(TABS[tab])}
            tabIndex={0}
          >
            {tab === 0 ? (
              <div className="stack">
                {desk.endpointUrl ? (
                  <div className="field">
                    <label className="label" htmlFor="endpoint-url">
                      Endpoint URL
                    </label>
                    <input className="textfield textfield-code" id="endpoint-url" value={desk.endpointUrl} readOnly />
                  </div>
                ) : (
                  <p className="notice notice-warning">{ENDPOINT_UNAVAILABLE}</p>
                )}
                <section className="card">
                  <h2 className="section-title">Create agent</h2>
                  <div className="grid">
                    <div className="field">
                      <label className="label" htmlFor="agent-name">
                        Name
                      </label>
                      <input
                        className="textfield"
                        id="agent-name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="agent-description">
                        Description
                      </label>
                      <input
                        className="textfield"
                        id="agent-description"
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="agent-projects">
                        Projects
                      </label>
                      <input
                        className="textfield"
                        id="agent-projects"
                        value={projects}
                        placeholder="PROJ, DOCS"
                        onChange={(event) => setProjects(event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="agent-write-mode">
                        Write mode
                      </label>
                      <select
                        className="textfield"
                        id="agent-write-mode"
                        value={writeMode}
                        onChange={(event) => setWriteMode(event.target.value)}
                      >
                        {desk.writeModes.map((mode) => (
                          <option key={mode} value={mode}>
                            {mode}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <fieldset className="fieldset">
                    <legend className="label">Tools</legend>
                    <div className="checks">
                      {desk.toolChoices.map((tool) => (
                        <label className="check" key={tool}>
                          <input
                            type="checkbox"
                            value={tool}
                            checked={tools.includes(tool)}
                            onChange={(event) => toggleTool(tool, event.target.checked)}
                          />
                          <span className="mono">{tool}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="actions">
                    <button type="button" className="button button-primary" disabled={locked} onClick={createAgent}>
                      Create agent
                    </button>
                  </div>
                </section>
                {desk.agents.length === 0 ? <p className="muted">No agents yet.</p> : null}
                {desk.agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    toolChoices={desk.toolChoices}
                    writeModes={desk.writeModes}
                    onRevoke={() => void run({ type: "revoke", agentId: agent.id })}
                    onSave={(command) => void run(command)}
                    locked={locked}
                  />
                ))}
              </div>
            ) : null}
            {tab === 1 ? (
              <div className="stack">
                {desk.approvals.length === 0 ? <p className="muted">No writes are waiting.</p> : null}
                {desk.approvals.map((row) => (
                  <section className="card" key={row.id}>
                    <div className="card-head">
                      <h2 className="section-title">
                        <span className="mono">{row.tool}</span> on <span className="mono">{row.issueKey}</span>
                      </h2>
                      <span className={`status status-${row.status}`}>{row.status}</span>
                    </div>
                    <p className="muted">{row.agentName}</p>
                    {row.diff.length === 0 ? (
                      <p className="muted">This action changes nothing.</p>
                    ) : (
                      <table className="table">
                        <thead>
                          <tr>
                            <th scope="col">Field</th>
                            <th scope="col">Before</th>
                            <th scope="col">After</th>
                          </tr>
                        </thead>
                        <tbody>
                          {row.diff.map((entry) => (
                            <tr key={entry.field}>
                              <th scope="row">{entry.field}</th>
                              <td className="mono">{literal(entry.before)}</td>
                              <td className="mono">{literal(entry.after)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {row.status === "pending" ? (
                      <div className="actions">
                        <button
                          type="button"
                          className="button button-primary"
                          disabled={locked}
                          onClick={() => void run({ type: "decide", actionId: row.id, verdict: "approve" })}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="button button-danger"
                          disabled={locked}
                          onClick={() => void run({ type: "decide", actionId: row.id, verdict: "reject" })}
                        >
                          Reject
                        </button>
                      </div>
                    ) : null}
                  </section>
                ))}
              </div>
            ) : null}
            {tab === 2 ? (
              <div className="stack">
                <section className="card">
                  <div className="grid">
                    <div className="field">
                      <label className="label" htmlFor="audit-agent">
                        Agent
                      </label>
                      <select
                        className="textfield"
                        id="audit-agent"
                        value={auditAgent}
                        onChange={(event) => setAuditAgent(event.target.value)}
                      >
                        <option value="">Any agent</option>
                        {desk.agents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="audit-outcome">
                        Outcome
                      </label>
                      <select
                        className="textfield"
                        id="audit-outcome"
                        value={auditOutcome}
                        onChange={(event) => setAuditOutcome(event.target.value)}
                      >
                        <option value="">Any outcome</option>
                        {desk.outcomes.map((outcome) => (
                          <option key={outcome} value={outcome}>
                            {outcome}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="audit-from">
                        From
                      </label>
                      <input
                        className="textfield"
                        id="audit-from"
                        type="date"
                        value={auditFrom}
                        onChange={(event) => setAuditFrom(asDay(event.target.value))}
                      />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="audit-to">
                        To
                      </label>
                      <input
                        className="textfield"
                        id="audit-to"
                        type="date"
                        value={auditTo}
                        onChange={(event) => setAuditTo(asDay(event.target.value))}
                      />
                    </div>
                  </div>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={auditInjection}
                      onChange={(event) => setAuditInjection(event.target.checked)}
                    />
                    <span>Injection flagged</span>
                  </label>
                  <div className="actions">
                    <button type="button" className="button button-primary" disabled={locked} onClick={filterAudit}>
                      Filter
                    </button>
                    <button type="button" className="button button-subtle" disabled={locked} onClick={clearAudit}>
                      Clear
                    </button>
                  </div>
                </section>
                {hint ? <p className="muted">{hint}</p> : null}
                {desk.audit.empty === "rows" ? (
                  <div className="table-wrap">
                    <table className="table">
                      <caption className="label">Audit log</caption>
                      <thead>
                        <tr>
                          <th scope="col">When</th>
                          <th scope="col">Agent</th>
                          <th scope="col">Tool</th>
                          <th scope="col">Outcome</th>
                          <th scope="col">Issue</th>
                          <th scope="col">Injection</th>
                          <th scope="col">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {desk.audit.events.map((event) => (
                          <tr key={event.id}>
                            <td className="mono nowrap">{event.ts}</td>
                            <td>{event.agentName}</td>
                            <td className="mono">{event.tool}</td>
                            <td>
                              <span className={`status status-${event.outcome}`}>{event.outcome}</span>
                            </td>
                            <td className="mono nowrap">{event.issueKey ?? ""}</td>
                            <td>{event.injectionFlagged ? <span className="status status-flagged">flagged</span> : <span className="muted">clear</span>}</td>
                            <td>{event.reason ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="stack">
          <p>Loading JiraGuard.</p>
          <div className="actions">
            <button
              type="button"
              className="button button-primary"
              disabled={locked}
              onClick={() => void run({ type: "open" })}
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentRow({ agent, toolChoices, writeModes, onRevoke, onSave, locked }) {
  const policyKey =
    agent.policy.kind === "set"
      ? `${agent.policy.allowedProjects.join(",")}|${agent.policy.allowedTools.join(",")}|${agent.policy.writeMode}`
      : "missing";
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">{agent.name}</h2>
        <span className={`status status-${agent.status}`}>{agent.status}</span>
      </div>
      {agent.description ? <p className="muted">{agent.description}</p> : null}
      <p className="muted">{agent.lastUsedAt ? `Last use ${agent.lastUsedAt}` : "No calls yet"}</p>
      <PolicyDraft
        key={`${agent.id}:${policyKey}`}
        agent={agent}
        toolChoices={toolChoices}
        writeModes={writeModes}
        onSave={onSave}
        locked={locked}
      />
      <div className="actions">
        <button type="button" className="button button-danger" disabled={locked} onClick={onRevoke}>
          Revoke
        </button>
      </div>
    </section>
  );
}

function PolicyDraft({ agent, toolChoices, writeModes, onSave, locked }) {
  const policy = agent.policy.kind === "set" ? agent.policy : null;
  const [projects, setProjects] = useState(policy ? policy.allowedProjects.join(", ") : "");
  const [tools, setTools] = useState(policy ? policy.allowedTools : []);
  const [writeMode, setWriteMode] = useState(policy ? policy.writeMode : "approve");
  if (!policy) {
    return <p className="muted">This agent has no policy.</p>;
  }
  return (
    <div className="stack">
      <div className="field">
        <label className="label" htmlFor={`${agent.id}-projects`}>
          Projects
        </label>
        <input
          className="textfield"
          id={`${agent.id}-projects`}
          value={projects}
          onChange={(event) => setProjects(event.target.value)}
        />
      </div>
      <fieldset className="fieldset">
        <legend className="label">Tools</legend>
        <div className="checks">
          {toolChoices.map((tool) => (
            <label className="check" key={tool}>
              <input
                type="checkbox"
                value={tool}
                checked={tools.includes(tool)}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setTools((current) =>
                    checked ? [...new Set([...current, tool])] : current.filter((item) => item !== tool),
                  );
                }}
              />
              <span className="mono">{tool}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label className="label" htmlFor={`${agent.id}-write-mode`}>
          Write mode
        </label>
        <select
          className="textfield"
          id={`${agent.id}-write-mode`}
          value={writeMode}
          onChange={(event) => setWriteMode(event.target.value)}
        >
          {writeModes.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </div>
      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          disabled={locked}
          onClick={() =>
            onSave({
              type: "savePolicy",
              agentId: agent.id,
              allowedProjects: projectKeys(projects),
              allowedTools: tools,
              writeMode,
            })
          }
        >
          Save policy
        </button>
      </div>
    </div>
  );
}
