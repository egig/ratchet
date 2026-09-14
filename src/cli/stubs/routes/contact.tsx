import { Form, useActionData, useNavigation } from 'react-router';
import { sql } from 'drizzle-orm';
import { getWebContext } from '@egig/ratchet/web';
import type { ActionFunctionArgs } from 'react-router';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Runs on the server only. Inserts a row into the "contacts" model (models/website/contact.model.ts)
// — no public API is exposed for it, so this is the submission path. "company" is a honeypot: a
// real person never sees or fills it.
export async function action({ request, context }: ActionFunctionArgs) {
  const form = await request.formData();
  if (form.get('company')) return { ok: true as const }; // bot — pretend it worked

  const name = String(form.get('name') ?? '').trim();
  const email = String(form.get('email') ?? '').trim();
  const message = String(form.get('message') ?? '').trim();

  const errors: Record<string, string> = {};
  if (!name) errors.name = 'Please enter your name.';
  if (!EMAIL_RE.test(email)) errors.email = 'Please enter a valid email address.';
  if (!message) errors.message = 'Please enter a message.';
  if (Object.keys(errors).length > 0) return { ok: false as const, errors, values: { name, email, message } };

  const { db } = getWebContext(context);
  // `now()` is Postgres-only — an ISO-8601 string computed here works on both drivers, matching
  // how the framework's own persistence layer timestamps every row.
  const now = new Date().toISOString();
  await db.execute(
    sql`insert into contacts (id, created_at, updated_at, name, email, message, status)
        values (${crypto.randomUUID()}, ${now}, ${now}, ${name}, ${email}, ${message}, 'new')`,
  );
  return { ok: true as const };
}

export const meta = () => [{ title: 'Contact' }];

export default function Contact() {
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state === 'submitting';
  const errors: Record<string, string> = result && !result.ok ? result.errors : {};
  const values = result && !result.ok ? result.values : { name: '', email: '', message: '' };

  if (result?.ok) {
    return (
      <div className="container prose">
        <h1>Thanks — we got your message</h1>
        <p>We'll get back to you as soon as we can.</p>
      </div>
    );
  }

  return (
    <div className="container prose">
      <h1>Contact</h1>
      <p>Send us a message and we'll reply by email.</p>
      <Form method="post" className="form" replace>
        <p className="form__hp" aria-hidden="true">
          <label>
            Company <input type="text" name="company" tabIndex={-1} autoComplete="off" />
          </label>
        </p>
        <label className="form__field">
          <span>Name</span>
          <input type="text" name="name" defaultValue={values.name} required />
          {errors.name ? <span className="form__error">{errors.name}</span> : null}
        </label>
        <label className="form__field">
          <span>Email</span>
          <input type="email" name="email" defaultValue={values.email} required />
          {errors.email ? <span className="form__error">{errors.email}</span> : null}
        </label>
        <label className="form__field">
          <span>Message</span>
          <textarea name="message" rows={6} defaultValue={values.message} required />
          {errors.message ? <span className="form__error">{errors.message}</span> : null}
        </label>
        <button type="submit" className="button button--primary" disabled={submitting}>
          {submitting ? 'Sending…' : 'Send message'}
        </button>
      </Form>
    </div>
  );
}
