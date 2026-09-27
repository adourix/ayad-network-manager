import { useState } from "react";
import { useAuth } from "./auth/AuthContext";

export default function AccountSettings() {
  const { changePassword, mustChangePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    setError("");

    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match.");
      return;
    }

    setPending(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setMessage("Password changed successfully.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to change password.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="panel form-panel">
      <div className="panel-title">
        <div>
          <span className="eyebrow">ADMINISTRATOR ACCOUNT</span>
          <h3>Change password</h3>
          <span>Update the password used to access Ayad Network Manager.</span>
        </div>
      </div>

      {mustChangePassword && (
        <div className="identity-callout warning">
          <span>!</span>
          <div>
            <h3>Default password is active</h3>
            <p>For security, change the initial <b>admin / admin</b> password before continuing.</p>
          </div>
        </div>
      )}

      <form onSubmit={submit}>
        <div className="form-grid">
          <label>
            Current password
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={event => setCurrentPassword(event.target.value)}
            />
          </label>
          <label>
            New password
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={newPassword}
              onChange={event => setNewPassword(event.target.value)}
            />
            <small>At least 8 characters.</small>
          </label>
          <label>
            Confirm new password
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={confirmPassword}
              onChange={event => setConfirmPassword(event.target.value)}
            />
          </label>
        </div>

        {error && <div className="error-box">{error}</div>}
        {message && <div className="notice">{message}</div>}

        <button className="primary" type="submit" disabled={pending}>
          {pending ? "Changing…" : "Change password"}
        </button>
      </form>
    </section>
  );
}
