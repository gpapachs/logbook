// ============================================================
// Supabase Edge Function: manage-users
// Επιτρέπει στην εφαρμογή (καρτέλα "Χρήστες") να βλέπει, να προσθέτει
// και να διαγράφει χρήστες σύνδεσης — χωρίς να χρειάζεται να μπαίνεις
// στο Supabase Dashboard κάθε φορά.
//
// Το service_role key (που μπορεί να κάνει τα πάντα στη βάση) ΔΕΝ φεύγει
// ποτέ από εδώ — μένει μέσα στο Edge Function, στον server του Supabase.
// Ο browser στέλνει μόνο το δικό του token σύνδεσης· η συνάρτηση το
// ελέγχει και επιτρέπει διαχείριση χρηστών ΜΟΝΟ στον λογαριασμό που
// ταιριάζει με το secret ADMIN_EMAIL (δες Βήμα 8 στο README).
//
// Οδηγίες ανάπτυξης (deploy): README.md, Βήμα 8.
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Μη εξουσιοδοτημένο αίτημα." }, 401);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ADMIN_EMAIL = (Deno.env.get("ADMIN_EMAIL") || "").trim().toLowerCase();

    if (!ADMIN_EMAIL) {
      return json({ error: "Λείπει το secret ADMIN_EMAIL στο Edge Function (δες Βήμα 8 στο README)." }, 500);
    }

    // Επιβεβαιώνουμε ότι ο καλών είναι πράγματι συνδεδεμένος χρήστης,
    // χρησιμοποιώντας το δικό του token (όχι το service key).
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: callerUser }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !callerUser) return json({ error: "Μη έγκυρη σύνδεση." }, 401);

    if ((callerUser.email || "").trim().toLowerCase() !== ADMIN_EMAIL) {
      return json({ error: "Μόνο ο λογαριασμός διαχειριστή μπορεί να διαχειρίζεται χρήστες." }, 403);
    }

    // Από εδώ και κάτω, χρησιμοποιούμε το service_role key (πλήρη πρόσβαση).
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const body = await req.json().catch(() => ({}));

    if (body.action === "list") {
      const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });
      if (error) return json({ error: error.message }, 400);
      const users = data.users
        .map((u) => ({ id: u.id, email: u.email, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at }))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return json({ users });
    }

    if (body.action === "create") {
      const email = String(body.email || "").trim();
      const password = String(body.password || "");
      if (!email || password.length < 6) {
        return json({ error: "Συμπλήρωσε email και κωδικό (τουλάχιστον 6 χαρακτήρες)." }, 400);
      }
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) return json({ error: error.message }, 400);
      return json({ user: { id: data.user.id, email: data.user.email } });
    }

    if (body.action === "delete") {
      const userId = String(body.userId || "");
      if (!userId) return json({ error: "Λείπει ο χρήστης." }, 400);
      const { data: targetData } = await admin.auth.admin.getUserById(userId);
      const targetEmail = (targetData?.user?.email || "").trim().toLowerCase();
      if (targetEmail === ADMIN_EMAIL) {
        return json({ error: "Δεν μπορείς να διαγράψεις τον λογαριασμό διαχειριστή." }, 400);
      }
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Άγνωστη ενέργεια." }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
