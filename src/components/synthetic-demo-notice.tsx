/** Persistent, non-dismissible safety statement for every deployed demo page. */
export function SyntheticDemoNotice() {
  return (
    <aside className="synthetic-demo-notice" aria-label="Synthetic demo safety notice">
      <strong>Synthetic demo only.</strong>
      <span>Not for clinical use. Do not enter, upload, or connect real patient data.</span>
    </aside>
  );
}
