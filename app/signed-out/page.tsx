import { chatGPTSignInPath } from "@/app/chatgpt-auth";
export const dynamic = "force-dynamic";
export default function SignedOut() {
  return (
    <main className="page narrow-page">
      <div className="empty-state">
        <div className="eyebrow">IDEA LAB</div>
        <h1>
          You’re signed out<span>.</span>
        </h1>
        <p>
          Your collection stays in Notion. Sign in through Sites to return to
          your private workspace.
        </p>
        <a className="site-primary" href={chatGPTSignInPath("/")} target="_top">
          Sign in through Sites
        </a>
      </div>
    </main>
  );
}
