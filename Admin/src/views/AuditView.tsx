import { Bot, FileClock, ShieldCheck, UserRound } from "lucide-react";
import { parseObject, shortId, text, time, type AdminItem } from "./utils";

function summary(value: unknown): Array<[string, string]> {
  return Object.entries(parseObject(value))
    .slice(0, 3)
    .map(([key, item]) => [key, typeof item === "string" || typeof item === "number" || typeof item === "boolean" ? String(item) : "…"]);
}

export function AuditView({ items }: { items: AdminItem[] }) {
  if (items.length === 0)
    return (
      <div className="empty-panel">
        <FileClock size={20} />
        <strong>감사 이벤트가 없습니다</strong>
        <p>관리 작업과 서비스 변경 이력이 시간순으로 기록됩니다.</p>
      </div>
    );
  return (
    <section className="audit-stream">
      <header>
        <ShieldCheck size={17} />
        <div>
          <strong>불변 감사 스트림</strong>
          <span>최근 {items.length}개 이벤트</span>
        </div>
      </header>
      <div className="audit-list">
        {items.map((item, index) => {
          const actorType = text(item.actor_type, "system");
          const details = summary(item.summary);
          return (
            <article key={text(item.id, String(index))} className="audit-entry">
              <span className="audit-node">{actorType === "user" ? <UserRound size={14} /> : <Bot size={14} />}</span>
              <div className="audit-copy">
                <div>
                  <strong>{text(item.action)}</strong>
                  <time>{time(item.created_at)}</time>
                </div>
                <p>
                  <span>{actorType}</span> {shortId(item.actor_id)} → <b>{text(item.target_type)}</b> {shortId(item.target_id)}
                </p>
                {details.length > 0 && (
                  <div className="audit-summary">
                    {details.map(([key, value]) => (
                      <span key={key}>
                        <b>{key}</b>
                        {value}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
