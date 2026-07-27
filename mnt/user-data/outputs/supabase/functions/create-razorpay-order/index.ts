// Deploy with: supabase functions deploy create-razorpay-order --no-verify-jwt
//
// Required secrets (set with `supabase secrets set`):
//   RAZORPAY_KEY_ID
//   RAZORPAY_KEY_SECRET
//   PROJECT_URL        e.g. https://abcdefgh.supabase.co
//   SERVICE_ROLE_KEY   from Project Settings -> API -> service_role key

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RAZORPAY_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID")!;
const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET")!;
// Using our own secret names (not the SUPABASE_ prefixed ones) because
// auto-injection of those has been inconsistent across projects/key systems.
const PROJECT_URL = Deno.env.get("PROJECT_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;


// The menu lives here, server-side, so a modified client request can
// never change what gets charged. Keep this in sync with the prices
// shown on the website.
const PRICES: Record<string, number> = {
  "croissant": 180,
  "cannoli": 220,
  "mille-feuille": 260,
  "sfogliatella": 210,
  "tiramisu": 240,
  "paris-brest": 280,
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // tighten to your GitHub Pages origin once live
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { items, customer } = await req.json();

    if (!Array.isArray(items) || items.length === 0) {
      return new Response(JSON.stringify({ error: "Cart is empty" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let subtotal = 0;
    const verifiedItems = items.map((it: { id: string; name: string; qty: number }) => {
      const price = PRICES[it.id];
      if (price === undefined) throw new Error(`Unknown item: ${it.id}`);
      const qty = Math.max(1, Math.min(20, Number(it.qty) || 1));
      subtotal += price * qty;
      return { id: it.id, name: it.name, price, qty };
    });

    const amountPaise = Math.round(subtotal * 100);

    const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: "INR",
        receipt: `mb_${Date.now()}`,
      }),
    });

    if (!rzpRes.ok) {
      const detail = await rzpRes.text();
      return new Response(JSON.stringify({ error: "Razorpay order creation failed", detail }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const rzpOrder = await rzpRes.json();

    const supabase = createClient(PROJECT_URL, SERVICE_ROLE_KEY);
    const { data: dbOrder, error } = await supabase
      .from("orders")
      .insert({
        customer_name: customer?.name ?? "",
        customer_email: customer?.email ?? "",
        customer_phone: customer?.phone ?? "",
        items: verifiedItems,
        subtotal,
        currency: "INR",
        razorpay_order_id: rzpOrder.id,
        status: "pending",
      })
      .select()
      .single();

    if (error) {
      return new Response(JSON.stringify({ error: "Database error", detail: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        order_id: rzpOrder.id,
        amount: amountPaise,
        currency: "INR",
        key_id: RAZORPAY_KEY_ID,
        db_order_id: dbOrder.id,
        order_number: `MB-${String(dbOrder.order_seq).padStart(7, "0")}`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});