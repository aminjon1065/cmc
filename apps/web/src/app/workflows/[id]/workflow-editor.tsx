"use client";

import { useCallback, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  Workflow,
  WorkflowDefinition,
  WorkflowNodeType,
  WorkflowRun,
} from "@cmc/contracts";
import {
  listRunsAction,
  runWorkflowAction,
  saveWorkflowAction,
  validateWorkflowAction,
} from "../actions";

const NODE_TYPES: WorkflowNodeType[] = [
  "start",
  "end",
  "notify",
  "delay",
  "condition",
  "create_incident",
];

type Cfg = Record<string, unknown>;

function defaultConfig(t: WorkflowNodeType): Cfg {
  switch (t) {
    case "notify":
      return { title: "Notify", body: "Workflow message" };
    case "delay":
      return { seconds: 60 };
    case "condition":
      return { path: "severity", equals: "5" };
    case "create_incident":
      return {
        severity: 3,
        type: "auto",
        region: "Unknown",
        summary: "Created by workflow",
      };
    default:
      return {};
  }
}

const uid = (p: string) =>
  `${p}_${(globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 8)}`;

function toRfNodes(def: WorkflowDefinition): Node[] {
  return def.nodes.map((n) => ({
    id: n.id,
    position: n.position ?? { x: 0, y: 0 },
    data: {
      nodeType: n.type,
      label: n.type,
      config: "config" in n ? (n.config as Cfg) : {},
    },
    style: nodeStyle(n.type),
  }));
}
function toRfEdges(def: WorkflowDefinition): Edge[] {
  return def.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.branch,
    data: { branch: e.branch },
  }));
}

function nodeStyle(t: string): React.CSSProperties {
  const accent =
    t === "start"
      ? "#22c55e"
      : t === "end"
        ? "#ef4444"
        : t === "condition"
          ? "#a78bfa"
          : "#5b8def";
  return {
    border: `1px solid ${accent}`,
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 11,
    background: "var(--c-bg-1)",
    color: "var(--c-fg-1)",
  };
}

export function WorkflowEditor({ initial }: { initial: Workflow }) {
  const t = useTranslations("workflows");
  const [nodes, setNodes] = useState<Node[]>(() => toRfNodes(initial.definition));
  const [edges, setEdges] = useState<Edge[]>(() => toRfEdges(initial.definition));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState(initial.name);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [triggerType, setTriggerType] = useState(initial.trigger.type);
  const [triggerEvent, setTriggerEvent] = useState(initial.trigger.event ?? "");
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  const onNodesChange = useCallback(
    (c: NodeChange[]) => setNodes((nds) => applyNodeChanges(c, nds)),
    [],
  );
  const onEdgesChange = useCallback(
    (c: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(c, eds)),
    [],
  );
  const onConnect = useCallback(
    (conn: Connection) => {
      setEdges((eds) => {
        const src = nodes.find((n) => n.id === conn.source);
        const isCond = (src?.data as { nodeType?: string })?.nodeType ===
          "condition";
        let branch: "true" | "false" | undefined;
        if (isCond) {
          const existing = eds.filter((e) => e.source === conn.source);
          branch = existing.some((e) => (e.data as { branch?: string })?.branch === "true")
            ? "false"
            : "true";
        }
        return addEdge(
          { ...conn, id: uid("e"), label: branch, data: { branch } },
          eds,
        );
      });
    },
    [nodes],
  );

  const selected = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  function addNode(t: WorkflowNodeType) {
    const id = uid("n");
    const i = nodes.length;
    setNodes((nds) => [
      ...nds,
      {
        id,
        position: { x: 80 + (i % 4) * 170, y: 60 + Math.floor(i / 4) * 110 },
        data: { nodeType: t, label: t, config: defaultConfig(t) },
        style: nodeStyle(t),
      },
    ]);
    setSelectedId(id);
  }

  function updateConfig(key: string, value: unknown) {
    if (!selectedId) return;
    setNodes((nds) =>
      nds.map((n) =>
        n.id === selectedId
          ? {
              ...n,
              data: {
                ...n.data,
                config: { ...(n.data as { config: Cfg }).config, [key]: value },
              },
            }
          : n,
      ),
    );
  }

  function deleteSelected() {
    if (!selectedId) return;
    setNodes((nds) => nds.filter((n) => n.id !== selectedId));
    setEdges((eds) =>
      eds.filter((e) => e.source !== selectedId && e.target !== selectedId),
    );
    setSelectedId(null);
  }

  function serialize(): WorkflowDefinition {
    return {
      nodes: nodes.map((n) => {
        const d = n.data as { nodeType: WorkflowNodeType; config: Cfg };
        const base = {
          id: n.id,
          type: d.nodeType,
          position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
        };
        const c = d.config ?? {};
        switch (d.nodeType) {
          case "notify":
            return {
              ...base,
              config: {
                title: String(c.title ?? ""),
                body: String(c.body ?? ""),
                ...(c.toUserId ? { toUserId: String(c.toUserId) } : {}),
              },
            };
          case "delay":
            return { ...base, config: { seconds: Number(c.seconds ?? 0) } };
          case "condition":
            return {
              ...base,
              config: { path: String(c.path ?? ""), equals: String(c.equals ?? "") },
            };
          case "create_incident":
            return {
              ...base,
              config: {
                severity: Number(c.severity ?? 3),
                type: String(c.type ?? ""),
                region: String(c.region ?? ""),
                summary: String(c.summary ?? ""),
              },
            };
          default:
            return base;
        }
      }) as WorkflowDefinition["nodes"],
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        ...((e.data as { branch?: "true" | "false" })?.branch
          ? { branch: (e.data as { branch: "true" | "false" }).branch }
          : {}),
      })),
    };
  }

  function trigger() {
    return triggerType === "event"
      ? { type: "event" as const, event: triggerEvent.trim() }
      : { type: "manual" as const };
  }

  async function onValidate() {
    setBusy(true);
    setMsg(null);
    const res = await validateWorkflowAction(serialize());
    setBusy(false);
    if (!res.ok) return setMsg({ kind: "err", text: res.error });
    setMsg(
      res.data.valid
        ? { kind: "ok", text: t("validValid") }
        : { kind: "err", text: res.data.errors.join("; ") },
    );
  }

  async function onSave() {
    setBusy(true);
    setMsg(null);
    const res = await saveWorkflowAction(initial.id, {
      name,
      definition: serialize(),
      enabled,
      trigger: trigger(),
    });
    setBusy(false);
    setMsg(
      res.ok
        ? { kind: "ok", text: t("saved", { version: res.data.version }) }
        : { kind: "err", text: res.error },
    );
  }

  async function onRun() {
    setBusy(true);
    setMsg(null);
    const res = await runWorkflowAction(initial.id);
    setBusy(false);
    if (!res.ok) return setMsg({ kind: "err", text: res.error });
    setMsg({ kind: "ok", text: t("runStarted", { status: res.data.status }) });
    void refreshRuns();
  }

  async function refreshRuns() {
    const res = await listRunsAction(initial.id);
    if (res.ok) setRuns(res.data);
  }

  const selData = selected?.data as
    | { nodeType: WorkflowNodeType; config: Cfg }
    | undefined;

  return (
    <div className="flex flex-col gap-3 p-5">
      {/* Toolbar */}
      <div className="cmc-card flex flex-wrap items-center gap-2 p-3">
        <input
          className="cmc-input"
          style={{ width: 220 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--c-fg-2)" }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t("enabled")}
        </label>
        <select
          className="cmc-input"
          style={{ width: 110 }}
          value={triggerType}
          onChange={(e) => setTriggerType(e.target.value as "manual" | "event")}
        >
          <option value="manual">{t("triggerManualOption")}</option>
          <option value="event">{t("triggerEventOption")}</option>
        </select>
        {triggerType === "event" && (
          <input
            className="cmc-input"
            style={{ width: 170 }}
            placeholder="incident.created"
            value={triggerEvent}
            onChange={(e) => setTriggerEvent(e.target.value)}
          />
        )}
        <div className="flex-1" />
        <button className="cmc-btn" onClick={onValidate} disabled={busy}>
          {t("validate")}
        </button>
        <button className="cmc-btn" onClick={onSave} disabled={busy}>
          {t("save")}
        </button>
        <button className="cmc-btn" onClick={onRun} disabled={busy}>
          {t("run")}
        </button>
      </div>

      {msg && (
        <div
          className="rounded-md p-2.5 text-[12px]"
          style={{
            color: msg.kind === "ok" ? "var(--c-accent)" : "var(--c-sev-1)",
            background:
              msg.kind === "ok"
                ? "color-mix(in srgb, var(--c-accent) 10%, transparent)"
                : "var(--c-sev-1-soft)",
          }}
        >
          {msg.text}
        </div>
      )}

      <div className="flex gap-3" style={{ minHeight: 520 }}>
        {/* Palette */}
        <div className="cmc-card flex flex-col gap-1.5 p-3" style={{ width: 150 }}>
          <div className="cmc-label mb-1">{t("addNode")}</div>
          {NODE_TYPES.map((t) => (
            <button
              key={t}
              className="cmc-btn text-left"
              style={{ justifyContent: "flex-start" }}
              onClick={() => addNode(t)}
            >
              + {t}
            </button>
          ))}
        </div>

        {/* Canvas */}
        <div
          className="cmc-card flex-1 overflow-hidden"
          style={{ height: 520 }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>

        {/* Inspector + runs */}
        <div className="flex flex-col gap-3" style={{ width: 240 }}>
          <div className="cmc-card p-3">
            <div className="cmc-label mb-2">
              {selData ? t("nodeSelected", { type: selData.nodeType }) : t("noNodeSelected")}
            </div>
            {selData && (
              <div className="flex flex-col gap-2">
                <ConfigFields
                  nodeType={selData.nodeType}
                  config={selData.config}
                  onChange={updateConfig}
                />
                <button
                  className="cmc-btn"
                  onClick={deleteSelected}
                  style={{ color: "var(--c-sev-1)" }}
                >
                  {t("deleteNode")}
                </button>
              </div>
            )}
            {!selData && (
              <div className="text-[11px]" style={{ color: "var(--c-fg-3)" }}>
                {t("clickNodeHint")}
              </div>
            )}
          </div>

          <div className="cmc-card p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="cmc-label">{t("recentRuns")}</span>
              <div className="flex-1" />
              <button className="cmc-btn" onClick={refreshRuns}>
                ↻
              </button>
            </div>
            {runs.length === 0 ? (
              <div className="text-[11px]" style={{ color: "var(--c-fg-3)" }}>
                {t("noRuns")}
              </div>
            ) : (
              <ul className="flex flex-col gap-1">
                {runs.slice(0, 8).map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between text-[11px]"
                    style={{ color: "var(--c-fg-2)" }}
                  >
                    <span className="cmc-mono">{r.id.slice(0, 8)}</span>
                    <span>{r.trigger}</span>
                    <span
                      style={{
                        color:
                          r.status === "completed"
                            ? "var(--c-accent)"
                            : r.status === "failed"
                              ? "var(--c-sev-1)"
                              : "var(--c-fg-3)",
                      }}
                    >
                      {r.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ConfigFields({
  nodeType,
  config,
  onChange,
}: {
  nodeType: WorkflowNodeType;
  config: Cfg;
  onChange: (key: string, value: unknown) => void;
}) {
  const t = useTranslations("workflows");
  const field = (
    key: string,
    label: string,
    type: "text" | "number" = "text",
  ) => (
    <label className="flex flex-col gap-1" key={key}>
      <span className="cmc-label">{label}</span>
      <input
        className="cmc-input"
        type={type}
        value={String(config[key] ?? "")}
        onChange={(e) =>
          onChange(key, type === "number" ? Number(e.target.value) : e.target.value)
        }
      />
    </label>
  );

  switch (nodeType) {
    case "notify":
      return (
        <>
          {field("title", t("fieldTitle"))}
          {field("body", t("fieldBody"))}
          {field("toUserId", t("fieldToUserId"))}
        </>
      );
    case "delay":
      return <>{field("seconds", t("fieldSeconds"), "number")}</>;
    case "condition":
      return (
        <>
          {field("path", t("fieldInputKey"))}
          {field("equals", t("fieldEquals"))}
        </>
      );
    case "create_incident":
      return (
        <>
          {field("severity", t("fieldSeverity"), "number")}
          {field("type", t("fieldType"))}
          {field("region", t("fieldRegion"))}
          {field("summary", t("fieldSummary"))}
        </>
      );
    default:
      return (
        <div className="text-[11px]" style={{ color: "var(--c-fg-3)" }}>
          {t("noConfiguration")}
        </div>
      );
  }
}
