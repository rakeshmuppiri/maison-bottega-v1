// Deploy with: supabase functions deploy verify-razorpay-payment --no-verify-jwt
//
// Required secrets: RAZORPAY_KEY_SECRET, PROJECT_URL, SERVICE_ROLE_KEY
// (same values used in create-razorpay-order)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET")!;
const PROJECT_URL = Deno.env.get("PROJECT_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // tighten to your GitHub Pages origin once live
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, db_order_id } = await req.json();

    // Razorpay's documented signature scheme: HMAC-SHA256 of "order_id|payment_id"
    const expected = await hmacHex(RAZORPAY_KEY_SECRET, `${razorpay_order_id}|${razorpay_payment_id}`);
    const valid = expected === razorpay_signature;

    const supabase = createClient(PROJECT_URL, SERVICE_ROLE_KEY);
    const { data: updated, error } = await supabase
      .from("orders")
      .update({
        status: valid ? "paid" : "failed",
        razorpay_payment_id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", db_order_id)
      .eq("razorpay_order_id", razorpay_order_id)
      .select()
      .single();

    return new Response(
      JSON.stringify({
        success: valid,
        order_number: updated ? `MB-${String(updated.order_seq).padStart(7, "0")}` : null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});