import Link from "next/link";

export default function Landing() {
  return (
    <main className="login">
      <div className="mark">C</div>
      <h1>cixtech</h1>
      <p>Custody engine consoles</p>
      <div className="row" style={{ justifyContent: "center", gap: 10 }}>
        <Link className="btn primary" href="/portal/">
          Tenant dashboard
        </Link>
        <Link className="btn" href="/admin/">
          Admin console
        </Link>
      </div>
    </main>
  );
}
