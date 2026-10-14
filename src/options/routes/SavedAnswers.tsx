import { useState } from "preact/hooks";
import { normalize } from "../../shared/normalize";
import { formatDateTime } from "../../shared/time";
import { useProfile } from "../store";

export function SavedAnswers() {
  const [profile, update] = useProfile();
  const [q, setQ] = useState("");
  if (!profile) return <p>Loading…</p>;
  const nq = normalize(q);
  const rows = profile.learnedAnswers.filter(
    (l) => !nq || normalize(`${l.question} ${l.answer} ${l.host}`).includes(nq),
  );
  const edit = (id: string, answer: string) =>
    update((p) => {
      const l = p.learnedAnswers.find((x) => x.id === id);
      if (l) l.answer = answer;
    });
  return (
    <section>
      <h1>Saved answers</h1>
      <p class="intro">
        Answers you gave on job pages. They fill matching questions instantly next time, without an AI call.
      </p>
      <input
        type="search"
        class="search"
        placeholder="Search saved answers"
        aria-label="Search saved answers"
        value={q}
        onInput={(e) => setQ(e.currentTarget.value)}
      />
      {rows.length === 0 ? (
        <p class="muted">{profile.learnedAnswers.length ? "No matches." : "No saved answers yet."}</p>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>Question</th>
              <th>Answer</th>
              <th>Host</th>
              <th>Saved</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr>
                <td>{l.question}</td>
                <td>
                  <input
                    aria-label={`Answer to ${l.question}`}
                    value={l.answer}
                    onInput={(e) => edit(l.id, e.currentTarget.value)}
                  />
                </td>
                <td class="muted">{l.host}</td>
                <td class="muted">{formatDateTime(l.createdAt)}</td>
                <td>
                  <button
                    type="button"
                    class="btn small danger"
                    onClick={() =>
                      update((p) => void (p.learnedAnswers = p.learnedAnswers.filter((x) => x.id !== l.id)))
                    }
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
