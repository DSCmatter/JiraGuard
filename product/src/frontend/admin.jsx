import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@forge/bridge";
import ForgeReconciler, {
  Button,
  Checkbox,
  DatePicker,
  DynamicTable,
  Heading,
  Inline,
  Label,
  SectionMessage,
  SectionMessageAction,
  Select,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textfield,
} from "@forge/react";

const SETUP_HINT = "Create an agent, then connect a client.";
const NO_MATCH_HINT = "No events match this filter.";
const ENDPOINT_UNAVAILABLE = "The endpoint URL is not available yet.";

function projectKeys(value) {
  return value.split(/[\s,]+/).filter((key) => key !== "");
}

function asDay(value) {
  if (typeof value !== "string" || value === "") {
    return "";
  }
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

function optionValue(option) {
  if (!option || Array.isArray(option) || typeof option.value !== "string") {
    return "";
  }
  return option.value;
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

function App() {
  const pending = useRef(false);
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

  const hint = desk ? auditHint(desk.audit.empty) : null;

  return (
    <Stack space="space.200">
      <Heading size="medium" as="h1">
        JiraGuard
      </Heading>
      {notice ? (
        <SectionMessage appearance="error">
          <Text>{notice}</Text>
        </SectionMessage>
      ) : null}
      {token ? (
        <SectionMessage
          title="Copy this token now. It is shown once."
          appearance="success"
          actions={[
            <SectionMessageAction key="dismiss" onClick={() => setToken(null)}>
              Dismiss
            </SectionMessageAction>,
          ]}
        >
          <Label labelFor="agent-token">Token</Label>
          <Textfield id="agent-token" value={token} isReadOnly isMonospaced />
        </SectionMessage>
      ) : null}
      {desk ? (
        <Tabs id="jiraguard-admin">
          <TabList>
            <Tab>Agents</Tab>
            <Tab>Approvals</Tab>
            <Tab>Audit</Tab>
          </TabList>
          <TabPanel>
            <Stack space="space.200">
              {desk.endpointUrl ? (
                <Stack space="space.050">
                  <Label labelFor="endpoint-url">Endpoint URL</Label>
                  <Textfield id="endpoint-url" value={desk.endpointUrl} isReadOnly isMonospaced />
                </Stack>
              ) : (
                <SectionMessage appearance="warning">
                  <Text>{ENDPOINT_UNAVAILABLE}</Text>
                </SectionMessage>
              )}
              <Heading size="small" as="h2">
                Create agent
              </Heading>
              <Label labelFor="agent-name">Name</Label>
              <Textfield id="agent-name" value={name} onChange={(event) => setName(event.target.value)} />
              <Label labelFor="agent-description">Description</Label>
              <Textfield
                id="agent-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
              <Label labelFor="agent-projects">Projects</Label>
              <Textfield
                id="agent-projects"
                value={projects}
                placeholder="PROJ, DOCS"
                onChange={(event) => setProjects(event.target.value)}
              />
              <Label>Tools</Label>
              {desk.toolChoices.map((tool) => (
                <Checkbox
                  key={tool}
                  label={tool}
                  value={tool}
                  isChecked={tools.includes(tool)}
                  onChange={(event) => toggleTool(tool, event.target.checked)}
                />
              ))}
              <Label labelFor="agent-write-mode">Write mode</Label>
              <Select
                id="agent-write-mode"
                options={desk.writeModes.map((mode) => ({ label: mode, value: mode }))}
                value={{ label: writeMode, value: writeMode }}
                onChange={(option) => {
                  const next = optionValue(option);
                  if (next !== "") {
                    setWriteMode(next);
                  }
                }}
              />
              <Button appearance="primary" isDisabled={locked} onClick={createAgent}>
                Create agent
              </Button>
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
            </Stack>
          </TabPanel>
          <TabPanel>
            <Stack space="space.200">
              {desk.approvals.length === 0 ? <Text>No writes are waiting.</Text> : null}
              {desk.approvals.map((row) => (
                <Stack key={row.id} space="space.100">
                  <Text>
                    {row.agentName} {row.tool} {row.issueKey} {row.status}
                  </Text>
                  {row.diff.map((entry) => (
                    <Text key={entry.field}>
                      {entry.field}: {JSON.stringify(entry.before)} to {JSON.stringify(entry.after)}
                    </Text>
                  ))}
                  {row.status === "pending" ? (
                    <Inline space="space.100">
                      <Button
                        appearance="primary"
                        isDisabled={locked}
                        onClick={() => void run({ type: "decide", actionId: row.id, verdict: "approve" })}
                      >
                        Approve
                      </Button>
                      <Button
                        appearance="danger"
                        isDisabled={locked}
                        onClick={() => void run({ type: "decide", actionId: row.id, verdict: "reject" })}
                      >
                        Reject
                      </Button>
                    </Inline>
                  ) : null}
                </Stack>
              ))}
            </Stack>
          </TabPanel>
          <TabPanel>
            <Stack space="space.200">
              <Label labelFor="audit-agent">Agent</Label>
              <Select
                id="audit-agent"
                isClearable
                placeholder="Any agent"
                options={desk.agents.map((agent) => ({ label: agent.name, value: agent.id }))}
                value={
                  auditAgent === ""
                    ? null
                    : {
                        label: desk.agents.find((agent) => agent.id === auditAgent)?.name ?? auditAgent,
                        value: auditAgent,
                      }
                }
                onChange={(option) => setAuditAgent(optionValue(option))}
              />
              <Label labelFor="audit-outcome">Outcome</Label>
              <Select
                id="audit-outcome"
                isClearable
                placeholder="Any outcome"
                options={desk.outcomes.map((outcome) => ({ label: outcome, value: outcome }))}
                value={auditOutcome === "" ? null : { label: auditOutcome, value: auditOutcome }}
                onChange={(option) => setAuditOutcome(optionValue(option))}
              />
              <Label labelFor="audit-from">From</Label>
              <DatePicker
                id="audit-from"
                shouldShowCalendarButton
                value={auditFrom}
                onChange={(value) => setAuditFrom(asDay(value))}
              />
              <Label labelFor="audit-to">To</Label>
              <DatePicker
                id="audit-to"
                shouldShowCalendarButton
                value={auditTo}
                onChange={(value) => setAuditTo(asDay(value))}
              />
              <Checkbox
                label="Injection flagged"
                isChecked={auditInjection}
                onChange={(event) => setAuditInjection(event.target.checked)}
              />
              <Inline space="space.100">
                <Button appearance="primary" onClick={filterAudit}>
                  Filter
                </Button>
                <Button
                  appearance="subtle"
                  onClick={() => {
                    setAuditAgent("");
                    setAuditOutcome("");
                    setAuditFrom("");
                    setAuditTo("");
                    setAuditInjection(false);
                    void run({ type: "filterAudit", filter: {} });
                  }}
                >
                  Clear
                </Button>
              </Inline>
              {hint ? <Text>{hint}</Text> : null}
              {desk.audit.empty === "rows" ? (
                <DynamicTable
                  label="Audit log"
                  head={{
                    cells: [
                      { key: "ts", content: "When" },
                      { key: "agent", content: "Agent" },
                      { key: "tool", content: "Tool" },
                      { key: "outcome", content: "Outcome" },
                      { key: "issue", content: "Issue" },
                      { key: "injection", content: "Injection" },
                      { key: "reason", content: "Reason" },
                    ],
                  }}
                  rows={desk.audit.events.map((event) => ({
                    key: event.id,
                    cells: [
                      { key: event.ts, content: event.ts },
                      { key: event.agentName, content: event.agentName },
                      { key: event.tool, content: event.tool },
                      { key: event.outcome, content: event.outcome },
                      { key: event.issueKey ?? "", content: event.issueKey ?? "" },
                      { key: event.injectionFlagged ? "flagged" : "clear", content: event.injectionFlagged ? "flagged" : "" },
                      { key: event.reason ?? "", content: event.reason ?? "" },
                    ],
                  }))}
                />
              ) : null}
            </Stack>
          </TabPanel>
        </Tabs>
      ) : (
        <Stack space="space.100">
          <Text>Loading JiraGuard.</Text>
          <Button appearance="primary" onClick={() => void run({ type: "open" })}>
            Retry
          </Button>
        </Stack>
      )}
    </Stack>
  );
}

function AgentRow({ agent, toolChoices, writeModes, onRevoke, onSave, locked }) {
  const policyKey =
    agent.policy.kind === "set"
      ? `${agent.policy.allowedProjects.join(",")}|${agent.policy.allowedTools.join(",")}|${agent.policy.writeMode}`
      : "missing";
  return (
    <Stack space="space.100">
      <Heading size="small" as="h2">
        {agent.name}
      </Heading>
      <Text>
        {agent.status} {agent.description}
      </Text>
      <Text>{agent.lastUsedAt ? `Last use ${agent.lastUsedAt}` : "No calls yet"}</Text>
      <PolicyDraft
        key={`${agent.id}:${policyKey}`}
        agent={agent}
        toolChoices={toolChoices}
        writeModes={writeModes}
        onSave={onSave}
        locked={locked}
      />
      <Button appearance="danger" isDisabled={locked} onClick={onRevoke}>
        Revoke
      </Button>
    </Stack>
  );
}

function PolicyDraft({ agent, toolChoices, writeModes, onSave, locked }) {
  const policy = agent.policy.kind === "set" ? agent.policy : null;
  const [projects, setProjects] = useState(policy ? policy.allowedProjects.join(", ") : "");
  const [tools, setTools] = useState(policy ? policy.allowedTools : []);
  const [writeMode, setWriteMode] = useState(policy ? policy.writeMode : "approve");
  if (!policy) {
    return <Text>This agent has no policy.</Text>;
  }
  return (
    <Stack space="space.100">
      <Label labelFor={`${agent.id}-projects`}>Projects</Label>
      <Textfield
        id={`${agent.id}-projects`}
        value={projects}
        onChange={(event) => setProjects(event.target.value)}
      />
      {toolChoices.map((tool) => (
        <Checkbox
          key={tool}
          label={tool}
          value={tool}
          isChecked={tools.includes(tool)}
          onChange={(event) => {
            const checked = event.target.checked;
            setTools((current) => (checked ? [...new Set([...current, tool])] : current.filter((item) => item !== tool)));
          }}
        />
      ))}
      <Label labelFor={`${agent.id}-write-mode`}>Write mode</Label>
      <Select
        id={`${agent.id}-write-mode`}
        options={writeModes.map((mode) => ({ label: mode, value: mode }))}
        value={{ label: writeMode, value: writeMode }}
        onChange={(option) => {
          const next = optionValue(option);
          if (next !== "") {
            setWriteMode(next);
          }
        }}
      />
      <Button
        appearance="primary"
        isDisabled={locked}
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
      </Button>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
