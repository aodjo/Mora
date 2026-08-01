import { Cloud, KeyRound, LockKeyhole, RefreshCw, Save, Settings2, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

interface RuntimeSetting {
  key: string;
  label: string;
  description: string;
  type: "boolean" | "number" | "origin" | "rp-id" | "secret" | "url";
  secret: boolean;
  configured: boolean;
  source: "database" | "default";
  value?: string;
  default_value?: string;
  updated_by?: string | null;
  updated_at?: number;
}

interface BindingStatus {
  key: string;
  kind: string;
  configured: boolean;
}

interface SettingsResponse {
  items: RuntimeSetting[];
  bindings: BindingStatus[];
}

function fieldType(item: RuntimeSetting): "number" | "password" | "text" | "url" {
  if (item.secret) return "password";
  if (item.type === "number") return "number";
  if (item.type === "url" || item.type === "origin") return "url";
  return "text";
}

export function SettingsPanel() {
  const [settings, setSettings] = useState<RuntimeSetting[]>([]);
  const [bindings, setBindings] = useState<BindingStatus[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState("Collector");
  const [issuedSecret, setIssuedSecret] = useState("");
  const [discord, setDiscord] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<SettingsResponse>("/settings");
      setSettings(result.items);
      setBindings(result.bindings);
      setValues(Object.fromEntries(result.items.map((item) => [item.key, item.secret ? "" : item.value ?? ""])));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "설정을 불러오지 못했습니다.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save(item: RuntimeSetting): Promise<void> {
    const value = values[item.key] ?? "";
    if (value.length === 0) { setError("저장할 값을 입력하세요."); return; }
    setBusyKey(item.key); setError(""); setNotice("");
    try {
      await api(`/settings/${encodeURIComponent(item.key)}`, { method: "PUT", body: JSON.stringify({ value }) });
      setNotice(`${item.label} 저장됨`);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "설정 저장 실패"); }
    finally { setBusyKey(null); }
  }

  async function reset(item: RuntimeSetting): Promise<void> {
    setBusyKey(item.key); setError(""); setNotice("");
    try {
      await api(`/settings/${encodeURIComponent(item.key)}`, { method: "DELETE" });
      setNotice(`${item.label} 기본값 복원됨`);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "설정 초기화 실패"); }
    finally { setBusyKey(null); }
  }

  async function createServiceKey(): Promise<void> {
    const result = await api<{ secret: string }>("/service-keys", { method: "POST", body: JSON.stringify({ name, scopes: ["collector.submit"] }) });
    setIssuedSecret(result.secret);
  }

  async function createEnrollment(): Promise<void> {
    const result = await api<{ token: string }>("/workers/enrollment", { method: "POST", body: "{}" });
    setIssuedSecret(result.token);
  }

  async function saveDiscord(): Promise<void> {
    await api("/notifications", { method: "POST", body: JSON.stringify({ kind: "discord", name: "Operations", url: discord, events: ["job.failed", "worker.offline", "queue.backlog", "canary.regression", "auth.anomaly"] }) });
    setDiscord(""); setNotice("Discord Webhook 저장됨");
  }

  return <div className="space-y-5">
    {(error || notice) && <div className={`alert ${error ? "error" : "success"}`}>{error || notice}</div>}

    <section className="settings-section">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="section-heading"><span className="section-icon"><Settings2 size={17}/></span><div><h2>서버 런타임 환경</h2><p>저장 즉시 적용됩니다. 비밀값은 다시 조회할 수 없습니다.</p></div></div>
        <button onClick={() => void load()} className="secondary-button"><RefreshCw size={14}/>새로고침</button>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {settings.map((item) => <article key={item.key} className="setting-card">
          <div className="mb-3 flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h3>{item.label}</h3>{item.secret&&<LockKeyhole size={13} className="secret-icon"/>}</div><code>{item.key}</code></div><span className={`config-badge ${item.configured ? "configured" : "default"}`}>{item.configured ? "설정됨" : "기본값"}</span></div>
          <p className="setting-description">{item.description}</p>
          <div className="flex gap-2">
            {item.type === "boolean" ? <select value={values[item.key] ?? "false"} onChange={(event) => setValues((old) => ({ ...old, [item.key]: event.target.value }))} className="form-control min-w-0 flex-1"><option value="false">비활성화</option><option value="true">활성화</option></select> : <input value={values[item.key] ?? ""} onChange={(event) => setValues((old) => ({ ...old, [item.key]: event.target.value }))} type={fieldType(item)} placeholder={item.secret ? item.configured ? "새 값으로 교체" : "비밀값 입력" : item.default_value ?? "값 입력"} step={item.type === "number" ? "any" : undefined} autoComplete="off" className="form-control min-w-0 flex-1"/>}
            <button disabled={busyKey===item.key} onClick={() => void save(item)} title="저장" className="square-primary-button"><Save size={15}/></button>
            {item.configured&&<button disabled={busyKey===item.key} onClick={() => void reset(item)} title="기본값 복원" className="square-button"><Trash2 size={15}/></button>}
          </div>
        </article>)}
      </div>
    </section>

    <section className="settings-section">
      <div className="section-heading mb-4"><span className="section-icon"><Cloud size={17}/></span><div><h2>Cloudflare Binding 및 루트 Secret</h2><p>인프라 수준 값은 Dashboard에서 노출하지 않으며 배포 도구로만 교체합니다.</p></div></div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{bindings.map((binding)=><div key={binding.key} className="binding-card"><div className="flex items-center justify-between gap-2"><code>{binding.key}</code><i className={`binding-dot ${binding.configured?"configured":"missing"}`}/></div><p>{binding.kind}</p></div>)}</div>
    </section>

    <div className="grid gap-5 lg:grid-cols-2">
      <section className="settings-section"><div className="section-heading mb-5"><span className="section-icon"><KeyRound size={17}/></span><h2>서비스·워커 자격증명</h2></div><input value={name} onChange={(event)=>setName(event.target.value)} className="form-control w-full"/><div className="mt-3 flex flex-wrap gap-2"><button onClick={()=>void createServiceKey()} className="primary-button">Collector 키 발급</button><button onClick={()=>void createEnrollment()} className="secondary-button">워커 등록 토큰</button></div>{issuedSecret&&<code className="issued-secret">한 번만 표시됩니다: {issuedSecret}</code>}</section>
      <section className="settings-section"><div className="section-heading mb-3"><span className="section-icon"><Users size={17}/></span><h2>Discord 알림</h2></div><input value={discord} onChange={(event)=>setDiscord(event.target.value)} type="password" placeholder="https://discord.com/api/webhooks/…" className="form-control w-full"/><button onClick={()=>void saveDiscord()} className="secondary-button mt-3">Write-only로 저장</button><p className="security-note">패스키, capability RBAC, write-only secret, 불변 감사 로그가 적용됩니다.</p></section>
    </div>
  </div>;
}
