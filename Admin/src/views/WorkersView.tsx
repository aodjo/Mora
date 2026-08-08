import { Box, CheckCircle2, Cpu, Pause, Play, Radio, ServerCog, XCircle } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { useToast } from "../Toast";
import { parseArray, parseObject, relativeTime, shortId, stateLabel, stateTone, text, type AdminItem } from "./utils";

export function WorkersView({ items, refresh }: { items: AdminItem[]; refresh: () => void }) {
  const { showToast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function setState(id: string, desired: "active" | "paused"): Promise<void> {
    setBusyId(id);
    try {
      await api(`/workers/${encodeURIComponent(id)}/state`, { method: "POST", body: JSON.stringify({ desired_state: desired }) });
      showToast(desired === "active" ? "워커를 다시 활성화했습니다." : "워커를 일시정지했습니다. 진행 중인 작업은 끝까지 처리됩니다.");
      refresh();
    } catch (reason) { showToast(reason instanceof Error ? reason.message : "워커 상태 변경 실패", { variant: "error" }); }
    finally { setBusyId(null); }
  }

  if (items.length === 0) return <div className="empty-panel"><Radio size={20}/><strong>연결된 Generator가 없습니다</strong><p>기기 연결에서 PIN을 승인하면 워커 상태를 확인할 수 있습니다.</p></div>;
  return <div className="worker-grid">{items.map((item) => {
    const id = text(item.id);
    const lastSeen = typeof item.last_seen_at === "number" ? item.last_seen_at : 0;
    const online = Date.now() - lastSeen < 120_000;
    const ready = item.production_ready === 1;
    const desired = text(item.desired_state, "unknown");
    const capabilities = parseArray(item.capabilities);
    const checks = Object.entries(parseObject(item.self_test));
    return <article key={id} className={`worker-card ${online && ready ? "online" : "offline"}`}>
      <div className="worker-head"><div className="worker-name"><span className="worker-machine"><ServerCog size={18}/></span><div><strong>{text(item.name, "이름 없는 Generator")}</strong><code title={id}>{shortId(id)}</code></div></div><span className={`worker-presence ${online && ready ? "online" : "offline"}`}><i/>{online && ready ? "온라인" : "확인 필요"}</span></div>
      <div className="worker-specs">
        <div><Cpu size={15}/><span>Backend</span><strong>{text(item.backend)}</strong></div>
        <div><Box size={15}/><span>Hardware</span><strong>{text(item.hardware)}</strong></div>
      </div>
      <div className="worker-capabilities">{capabilities.length > 0 ? capabilities.map((value) => <span key={value}>{value}</span>) : <span>capability 정보 없음</span>}</div>
      <div className="worker-checks">{checks.slice(0, 6).map(([name, result]) => <span key={name}>{result === "passed" ? <CheckCircle2 size={13}/> : <XCircle size={13}/>}<b>{name}</b></span>)}</div>
      <footer><span className={`state-badge ${stateTone(desired)}`}>{stateLabel(desired)}</span><span>v{text(item.version)}</span><time>{relativeTime(item.last_seen_at)}</time></footer>
      <div className="worker-actions">{desired === "active"
        ? <button disabled={busyId === id} onClick={() => void setState(id, "paused")}><Pause size={13}/>일시정지</button>
        : <button disabled={busyId === id} onClick={() => void setState(id, "active")}><Play size={13}/>재개</button>}</div>
    </article>;
  })}</div>;
}
