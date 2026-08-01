import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";
import { api, type AuthStatus } from "./api";
import { ThemeToggle, type Theme } from "./ThemeToggle";

export function Auth({ status, onAuthenticated, theme, onToggleTheme }: { status: AuthStatus; onAuthenticated: () => void; theme: Theme; onToggleTheme: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const embedded = window.self !== window.top;

  async function run(): Promise<void> {
    if (embedded) {
      window.open(window.location.href, "_blank", "noopener,noreferrer");
      setError("패스키 등록은 임베디드 창에서 허용되지 않습니다. 새 브라우저 탭에서 계속하세요.");
      return;
    }
    setBusy(true); setError("");
    try {
      if (!status.bootstrapped) {
        const created = await api<{ challenge_id: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>("/auth/bootstrap/options", { method: "POST", headers: { authorization: `Bearer ${bootstrapToken}` }, body: JSON.stringify({ email, display_name: name }) });
        const response = await startRegistration({ optionsJSON: created.options });
        await api("/auth/bootstrap/verify", { method: "POST", body: JSON.stringify({ challenge_id: created.challenge_id, response }) });
      } else {
        const challenge = await api<{ challenge_id: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/auth/login/options", { method: "POST", body: JSON.stringify({ email }) });
        const response = await startAuthentication({ optionsJSON: challenge.options });
        await api("/auth/login/verify", { method: "POST", body: JSON.stringify({ challenge_id: challenge.challenge_id, response }) });
      }
      onAuthenticated();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "인증에 실패했습니다.";
      setError(/CredentialsContainer request is not allowed|NotAllowedError/iu.test(message)
        ? "브라우저가 패스키 요청을 차단했습니다. Safari 또는 Chrome의 최상위 탭에서 이 주소를 직접 열어 다시 시도하세요."
        : message);
    }
    finally { setBusy(false); }
  }

  return <main className="auth-shell">
    <div className="auth-theme"><ThemeToggle theme={theme} onToggle={onToggleTheme}/></div>
    <section className="auth-card">
      <div className="auth-brand"><span className="brand-mark">M</span><strong>Mora</strong></div>
      <div className="auth-heading"><h1>{status.bootstrapped ? "관리자 로그인" : "관리자 계정 만들기"}</h1><p>{status.bootstrapped ? "등록한 패스키로 안전하게 로그인하세요." : "첫 번째 관리자와 패스키를 등록합니다."}</p></div>
      <label className="field-label">이메일<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className="form-input" placeholder="admin@example.com" autoComplete="username webauthn" /></label>
      {!status.bootstrapped && <><label className="field-label">표시 이름<input value={name} onChange={(e) => setName(e.target.value)} className="form-input" placeholder="관리자" autoComplete="name" /></label><label className="field-label">Bootstrap token<input value={bootstrapToken} onChange={(e) => setBootstrapToken(e.target.value)} type="password" className="form-input" autoComplete="off" /></label></>}
      {error && <p className="alert error">{error}</p>}
      {embedded&&<p className="alert warning">이 화면은 임베디드 브라우저입니다. 패스키는 새 Safari 또는 Chrome 탭에서 등록해야 합니다.</p>}
      <button disabled={busy || email.length === 0} onClick={() => void run()} className="primary-button auth-submit">{busy ? "확인 중…" : embedded ? "새 브라우저 탭에서 열기" : status.bootstrapped ? "패스키로 로그인" : "관리자 등록"}</button>
      <p className="auth-footnote">비밀번호 없이 기기의 패스키로 인증합니다.</p>
    </section>
  </main>;
}
