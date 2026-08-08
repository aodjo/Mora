import { Cloud, Copy, KeyRound, LockKeyhole, Plus, RefreshCw, Save, Settings2, ShieldCheck, Trash2, Users, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useToast } from "./Toast";
import { parseArray, relativeTime, text, time } from "./views/utils";

interface RuntimeSetting {
  key: string;
  label: string;
  description: string;
  type: "boolean" | "number" | "origin" | "rp-id" | "secret" | "string" | "url";
  component: "server" | "collector";
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
  const { showToast } = useToast();
  const [settings, setSettings] = useState<RuntimeSetting[]>([]);
  const [bindings, setBindings] = useState<BindingStatus[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [discord, setDiscord] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<SettingsResponse>("/settings");
      setSettings(result.items);
      setBindings(result.bindings);
      setValues(Object.fromEntries(result.items.map((item) => [item.key, item.secret ? "" : item.value ?? ""])));
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "설정을 불러오지 못했습니다.", { variant: "error" });
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);

  async function save(item: RuntimeSetting): Promise<void> {
    const value = values[item.key] ?? "";
    if (value.length === 0) { showToast("저장할 값을 입력하세요.", { variant: "error" }); return; }
    setBusyKey(item.key);
    try {
      await api(`/settings/${encodeURIComponent(item.key)}`, { method: "PUT", body: JSON.stringify({ value }) });
      showToast(`${item.label} 설정을 저장했습니다.`);
      await load();
    } catch (reason) { showToast(reason instanceof Error ? reason.message : "설정 저장 실패", { variant: "error" }); }
    finally { setBusyKey(null); }
  }

  async function reset(item: RuntimeSetting): Promise<void> {
    setBusyKey(item.key);
    try {
      await api(`/settings/${encodeURIComponent(item.key)}`, { method: "DELETE" });
      showToast(`${item.label} 설정을 기본값으로 복원했습니다.`);
      await load();
    } catch (reason) { showToast(reason instanceof Error ? reason.message : "설정 초기화 실패", { variant: "error" }); }
    finally { setBusyKey(null); }
  }

  async function saveDiscord(): Promise<void> {
    try {
      await api("/notifications", { method: "POST", body: JSON.stringify({ kind: "discord", name: "Operations", url: discord, events: ["job.failed", "worker.offline", "queue.backlog", "canary.regression", "auth.anomaly"] }) });
      setDiscord("");
      showToast("Discord Webhook을 저장했습니다.");
    } catch (reason) { showToast(reason instanceof Error ? reason.message : "Discord Webhook 저장 실패", { variant: "error" }); }
  }

  return <div className="space-y-5">
    {([
      ["server", "Server 런타임", "Cloudflare Worker와 공개 데이터 승격 정책입니다."],
      ["collector", "Collector 런타임", "Collector는 시작 시와 실행 대기 중 이 설정을 Admin에서 다시 읽습니다."],
    ] as const).map(([component, title, description]) => <section key={component} className="settings-section">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="section-heading"><span className="section-icon"><Settings2 size={17}/></span><div><h2>{title}</h2><p>{description} 비밀값은 다시 표시하지 않습니다.</p></div></div>
        <button onClick={() => void load()} className="secondary-button"><RefreshCw size={14}/>새로고침</button>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {settings.filter((item) => item.component === component).map((item) => <article key={item.key} className="setting-card">
          <div className="mb-3 flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h3>{item.label}</h3>{item.secret&&<LockKeyhole size={13} className="secret-icon"/>}</div><code>{item.key}</code></div><span className={`config-badge ${item.configured ? "configured" : "default"}`}>{item.configured ? "설정됨" : "기본값"}</span></div>
          <p className="setting-description">{item.description}</p>
          <div className="flex gap-2">
            {item.type === "boolean" ? <select value={values[item.key] ?? "false"} onChange={(event) => setValues((old) => ({ ...old, [item.key]: event.target.value }))} className="form-control min-w-0 flex-1"><option value="false">비활성화</option><option value="true">활성화</option></select> : <input value={values[item.key] ?? ""} onChange={(event) => setValues((old) => ({ ...old, [item.key]: event.target.value }))} type={fieldType(item)} placeholder={item.secret ? item.configured ? "새 값으로 교체" : "비밀값 입력" : item.default_value ?? "값 입력"} step={item.type === "number" ? "any" : undefined} autoComplete="off" className="form-control min-w-0 flex-1"/>}
            <button disabled={busyKey===item.key} onClick={() => void save(item)} title="저장" className="square-primary-button"><Save size={15}/></button>
            {item.configured&&<button disabled={busyKey===item.key} onClick={() => void reset(item)} title="기본값 복원" className="square-button"><Trash2 size={15}/></button>}
          </div>
        </article>)}
      </div>
    </section>)}

    <section className="settings-section">
      <div className="section-heading mb-4"><span className="section-icon"><Cloud size={17}/></span><div><h2>Cloudflare Binding 및 루트 Secret</h2><p>인프라 수준 값은 Dashboard에서 노출하지 않으며 배포 도구로만 교체합니다.</p></div></div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{bindings.map((binding)=><div key={binding.key} className="binding-card"><div className="flex items-center justify-between gap-2"><code>{binding.key}</code><i className={`binding-dot ${binding.configured?"configured":"missing"}`}/></div><p>{binding.kind}</p></div>)}</div>
    </section>

    <RolesPanel/>
    <ServiceKeysPanel/>

    <section className="settings-section"><div className="section-heading mb-3"><span className="section-icon"><Users size={17}/></span><h2>Discord 알림</h2></div><input value={discord} onChange={(event)=>setDiscord(event.target.value)} type="password" placeholder="https://discord.com/api/webhooks/…" className="form-control w-full"/><button onClick={()=>void saveDiscord()} className="secondary-button mt-3">Write-only로 저장</button><p className="security-note">패스키, capability RBAC, write-only secret, 불변 감사 로그가 적용됩니다.</p></section>
  </div>;
}

interface RoleItem { id: string; name: string; permissions: string; system: number; created_at: number }
interface UserItem { id: string; email: string; display_name: string; status: string; created_at: number; role_ids: string }

function RolesPanel() {
  const { showToast } = useToast();
  const [roles, setRoles] = useState<RoleItem[]>([]);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [roleResult, userResult] = await Promise.all([api<{ items: RoleItem[] }>("/roles"), api<{ items: UserItem[] }>("/users")]);
      setRoles(roleResult.items);
      setUsers(userResult.items);
    } catch (reason) { showToast(reason instanceof Error ? reason.message : "역할 정보를 불러오지 못했습니다.", { variant: "error" }); }
  }, [showToast]);
  useEffect(() => { void load(); }, [load]);

  function edit(role: RoleItem): void { setEditingId(role.id); setName(role.name); setPermissions(parseArray(role.permissions).join(", ")); }
  function reset(): void { setEditingId(null); setName(""); setPermissions(""); }

  async function submit(): Promise<void> {
    const parsed = permissions.split(/[\s,]+/u).map((value) => value.trim()).filter((value) => value.length > 0);
    if (name.trim().length === 0 || parsed.length === 0) { showToast("역할 이름과 권한을 입력하세요.", { variant: "error" }); return; }
    setBusy(true);
    try {
      await api("/roles", { method: "POST", body: JSON.stringify({ ...(editingId === null ? {} : { id: editingId }), name: name.trim(), permissions: parsed }) });
      showToast(editingId === null ? "역할을 만들었습니다." : "역할을 수정했습니다.");
      reset();
      await load();
    } catch (reason) { showToast(reason instanceof Error ? reason.message : "역할 저장 실패", { variant: "error" }); }
    finally { setBusy(false); }
  }

  async function assign(userId: string, roleId: string): Promise<void> {
    try { await api(`/users/${encodeURIComponent(userId)}/roles`, { method: "POST", body: JSON.stringify({ role_id: roleId }) }); showToast("역할을 부여했습니다."); await load(); }
    catch (reason) { showToast(reason instanceof Error ? reason.message : "역할 부여 실패", { variant: "error" }); }
  }

  async function unassign(userId: string, roleId: string): Promise<void> {
    try { await api(`/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`, { method: "DELETE" }); showToast("역할을 해제했습니다."); await load(); }
    catch (reason) { showToast(reason instanceof Error ? reason.message : "역할 해제 실패", { variant: "error" }); }
  }

  return <section className="settings-section">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div className="section-heading"><span className="section-icon"><ShieldCheck size={17}/></span><div><h2>역할과 권한</h2><p>권한은 <code>*</code> 또는 <code>jobs.manage</code> 같은 capability 문자열입니다.</p></div></div>
      <button onClick={() => void load()} className="secondary-button"><RefreshCw size={14}/>새로고침</button>
    </div>

    <div className="role-form">
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="역할 이름 (예: 검수자)" maxLength={100} className="form-control"/>
      <input value={permissions} onChange={(event) => setPermissions(event.target.value)} placeholder="candidates.read, candidates.approve, timing.edit" className="form-control"/>
      <button disabled={busy} onClick={() => void submit()} className="primary-button"><Plus size={14}/>{editingId === null ? "역할 추가" : "역할 수정"}</button>
      {editingId !== null && <button disabled={busy} onClick={reset} className="secondary-button">취소</button>}
    </div>

    <div className="role-list">{roles.map((role) => <article key={role.id} className={`role-card${editingId === role.id ? " editing" : ""}`}>
      <div><strong>{role.name}</strong>{role.system === 1 && <span className="role-system">시스템</span>}</div>
      <div className="permission-chips">{parseArray(role.permissions).map((permission) => <span key={permission}>{permission}</span>)}</div>
      <button onClick={() => edit(role)} className="secondary-button">수정</button>
    </article>)}</div>

    <div className="section-heading mt-6 mb-3"><span className="section-icon"><Users size={17}/></span><div><h2>관리자 계정</h2><p>패스키로 등록된 계정에 역할을 부여합니다.</p></div></div>
    {users.length === 0 ? <p className="security-note">등록된 관리자 계정이 없습니다.</p> : <div className="user-list">{users.map((user) => {
      const assigned = parseArray(user.role_ids);
      const available = roles.filter((role) => !assigned.includes(role.id));
      return <article key={user.id} className="user-card">
        <div><strong>{text(user.display_name)}</strong><code>{text(user.email)}</code></div>
        <div className="permission-chips">{assigned.length === 0 ? <span className="role-empty">역할 없음</span> : assigned.map((roleId) => <span key={roleId}>{roles.find((role) => role.id === roleId)?.name ?? roleId}<button onClick={() => void unassign(user.id, roleId)} aria-label="역할 해제"><X size={11}/></button></span>)}</div>
        <select value="" disabled={available.length === 0} onChange={(event) => { if (event.target.value.length > 0) void assign(user.id, event.target.value); }} className="form-control">
          <option value="">{available.length === 0 ? "부여할 역할 없음" : "역할 부여…"}</option>
          {available.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
        </select>
      </article>;
    })}</div>}
  </section>;
}

interface ServiceKeyItem { id: string; name: string; prefix: string; scopes: string; revoked_at: number | null; last_used_at: number | null; created_at: number }

function ServiceKeysPanel() {
  const { showToast } = useToast();
  const [keys, setKeys] = useState<ServiceKeyItem[]>([]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("");
  const [issued, setIssued] = useState<{ label: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setKeys((await api<{ items: ServiceKeyItem[] }>("/service-keys")).items); }
    catch (reason) { showToast(reason instanceof Error ? reason.message : "서비스 키를 불러오지 못했습니다.", { variant: "error" }); }
  }, [showToast]);
  useEffect(() => { void load(); }, [load]);

  async function create(): Promise<void> {
    const parsed = scopes.split(/[\s,]+/u).map((value) => value.trim()).filter((value) => value.length > 0);
    if (name.trim().length === 0 || parsed.length === 0) { showToast("키 이름과 scope를 입력하세요.", { variant: "error" }); return; }
    setBusy(true);
    try {
      const result = await api<{ secret: string }>("/service-keys", { method: "POST", body: JSON.stringify({ name: name.trim(), scopes: parsed }) });
      setIssued({ label: name.trim(), secret: result.secret });
      setName(""); setScopes("");
      showToast("서비스 키를 발급했습니다. 이 값은 다시 표시되지 않습니다.");
      await load();
    } catch (reason) { showToast(reason instanceof Error ? reason.message : "서비스 키 발급 실패", { variant: "error" }); }
    finally { setBusy(false); }
  }

  async function enrollment(): Promise<void> {
    setBusy(true);
    try {
      const result = await api<{ token: string }>("/workers/enrollment", { method: "POST", body: "{}" });
      setIssued({ label: "Generator 등록 토큰 (10분 유효)", secret: result.token });
      showToast("등록 토큰을 발급했습니다.");
    } catch (reason) { showToast(reason instanceof Error ? reason.message : "등록 토큰 발급 실패", { variant: "error" }); }
    finally { setBusy(false); }
  }

  return <section className="settings-section">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div className="section-heading"><span className="section-icon"><KeyRound size={17}/></span><div><h2>서비스 키</h2><p>Collector·Generator는 PIN 연결로 자동 발급됩니다. 여기서는 외부 연동용 키를 직접 만듭니다.</p></div></div>
      <button onClick={() => void load()} className="secondary-button"><RefreshCw size={14}/>새로고침</button>
    </div>

    <div className="role-form">
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="키 이름 (예: 외부 리포팅)" maxLength={100} className="form-control"/>
      <input value={scopes} onChange={(event) => setScopes(event.target.value)} placeholder="dashboard.read, jobs.read" className="form-control"/>
      <button disabled={busy} onClick={() => void create()} className="primary-button"><Plus size={14}/>키 발급</button>
      <button disabled={busy} onClick={() => void enrollment()} className="secondary-button">등록 토큰</button>
    </div>

    {issued !== null && <div className="issued-secret">
      <div><strong>{issued.label}</strong><p>지금 복사하세요. 이 값은 다시 조회할 수 없습니다.</p></div>
      <code>{issued.secret}</code>
      <div className="issued-actions">
        <button onClick={() => { void navigator.clipboard.writeText(issued.secret).then(() => showToast("클립보드에 복사했습니다.")).catch(() => showToast("복사에 실패했습니다. 직접 선택해 복사하세요.", { variant: "error" })); }} className="secondary-button"><Copy size={13}/>복사</button>
        <button onClick={() => setIssued(null)} className="secondary-button">숨기기</button>
      </div>
    </div>}

    {keys.length === 0 ? <p className="security-note">발급된 서비스 키가 없습니다.</p> : <div className="key-list">{keys.map((key) => <article key={key.id} className={`key-card${key.revoked_at === null ? "" : " revoked"}`}>
      <div><strong>{text(key.name)}</strong><code>{text(key.prefix)}…</code></div>
      <div className="permission-chips">{parseArray(key.scopes).slice(0, 6).map((scope) => <span key={scope}>{scope}</span>)}</div>
      <div className="key-meta"><span>{key.revoked_at === null ? `마지막 사용 ${relativeTime(key.last_used_at)}` : "폐기됨"}</span><time>{time(key.created_at)}</time></div>
    </article>)}</div>}
  </section>;
}

export function ConnectionsPanel() {
  const { showToast } = useToast();
  const [collectorPin, setCollectorPin] = useState("");
  const [generatorPin, setGeneratorPin] = useState("");

  async function approve(kind: "collector" | "generator", pin: string): Promise<void> {
    try {
      await api(`/${kind}/pairings/approve`, { method: "POST", body: JSON.stringify({ pin }) });
      if (kind === "collector") setCollectorPin(""); else setGeneratorPin("");
      showToast(`${kind === "collector" ? "Collector" : "Generator"} 연결을 승인했습니다.`);
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "연결 승인 실패", { variant: "error" });
    }
  }

  return <div className="space-y-5">
    <section className="connection-guide">
      <div><span>01</span><strong>터미널에서 실행</strong><p><code>npm run collector</code> 또는 <code>npm run generator</code></p></div>
      <i/>
      <div><span>02</span><strong>10자리 PIN 입력</strong><p>아래의 해당 서비스 입력란에 붙여 넣습니다.</p></div>
      <i/>
      <div><span>03</span><strong>자동 인증 완료</strong><p>자격증명은 실행 중인 Mac에 안전하게 저장됩니다.</p></div>
    </section>
    <div className="grid gap-5 lg:grid-cols-2">
      <PairingCard kind="collector" title="Collector 연결" command="npm run collector" pin={collectorPin} onPin={setCollectorPin} onApprove={() => void approve("collector", collectorPin)} description="PIN은 10분간 유효합니다. 승인되면 Collector가 서비스 키를 직접 받아 저장합니다."/>
      <PairingCard kind="generator" title="Generator 연결" command="npm run generator" pin={generatorPin} onPin={setGeneratorPin} onApprove={() => void approve("generator", generatorPin)} description="환경 점검을 통과한 Generator만 연결을 요청할 수 있습니다."/>
    </div>
  </div>;
}

function PairingCard({ kind, title, command, pin, onPin, onApprove, description }: { kind: "collector" | "generator"; title: string; command: string; pin: string; onPin: (value: string) => void; onApprove: () => void; description: string }) {
  const digits = pin.replace(/\D/gu, "");
  return <section className="settings-section pairing-card">
    <div className="section-heading mb-5"><span className="section-icon"><KeyRound size={17}/></span><div><h2>{title}</h2><p><code>{command}</code>에 표시된 PIN을 승인합니다.</p></div></div>
    <label className="pairing-label" htmlFor={`${kind}-pairing-pin`}>10자리 연결 PIN</label>
    <div className="flex gap-2"><input id={`${kind}-pairing-pin`} value={pin} onChange={(event) => onPin(event.target.value.replace(/[^\d\s-]/gu, ""))} inputMode="numeric" maxLength={12} placeholder="000 000 0000" autoComplete="one-time-code" className="form-control pairing-input min-w-0 flex-1"/><button disabled={digits.length !== 10} onClick={onApprove} className="primary-button">연결 승인</button></div>
    <p className="security-note">{description}</p>
  </section>;
}
