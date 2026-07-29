// Deploy with: supabase functions deploy verify-razorpay-payment --no-verify-jwt
//
// Required secrets: RAZORPAY_KEY_SECRET, PROJECT_URL, SERVICE_ROLE_KEY
// (same values used in create-razorpay-order), plus:
//   RESEND_API_KEY   from resend.com/api-keys
//   FROM_EMAIL       e.g. "Maison & Bottega <orders@yourdomain.com>"
//                    Until you verify a domain with Resend, use
//                    "Maison & Bottega <onboarding@resend.dev>" — this only
//                    delivers to the email address you signed up to Resend with.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET")!;
const PROJECT_URL = Deno.env.get("PROJECT_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") ?? "Maison & Bottega <onboarding@resend.dev>";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // tighten to your GitHub Pages origin once live
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function buildOrderEmailHtml(order: {
  order_number: string;
  customer_name: string;
  items: { name: string; price: number; qty: number }[];
  subtotal: number;
  currency: string;
}): string {
  const rows = order.items.map(i => `
    <tr>
      <td style="padding:10px 0; border-bottom:1px solid #e7ded0; font-family:Georgia, serif; font-style:italic; color:#2A1D14;">${i.name}</td>
      <td style="padding:10px 0; border-bottom:1px solid #e7ded0; text-align:center; font-family:monospace; color:#5A493B;">×${i.qty}</td>
      <td style="padding:10px 0; border-bottom:1px solid #e7ded0; text-align:right; font-family:monospace; color:#2A1D14;">₹${i.price * i.qty}</td>
    </tr>`).join("");

  return `
  <div style="background:#F7F1E6; padding:40px 20px; font-family:Helvetica, Arial, sans-serif;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border:1px solid #e7ded0; padding:36px;">
      <p style="font-family:Georgia, serif; font-size:22px; color:#2A1D14; margin:0 0 4px;">Maison &amp; Bottega</p>
      <p style="font-size:11px; letter-spacing:2px; text-transform:uppercase; color:#AD3A52; margin:0 0 28px;">Order Confirmed</p>

      <p style="font-family:Georgia, serif; font-style:italic; font-size:26px; color:#AD3A52; border:1px dashed #AD3A52; display:inline-block; padding:8px 18px; border-radius:999px; margin:0 0 24px;">${order.order_number}</p>

      <p style="font-size:14px; color:#2A1D14; margin:0 0 20px;">Bonjour ${order.customer_name || "there"}, buongiorno — your order is confirmed. Here's what's coming your way:</p>

      <table style="width:100%; border-collapse:collapse; margin-bottom:16px;">
        ${rows}
      </table>

      <table style="width:100%; border-top:2px solid #2A1D14; padding-top:10px;">
        <tr>
          <td style="font-family:Georgia, serif; font-size:16px; color:#2A1D14; padding-top:10px;">Total paid</td>
          <td style="font-family:monospace; font-size:16px; color:#2A1D14; text-align:right; padding-top:10px;">₹${order.subtotal}</td>
        </tr>
      </table>

      <p style="font-size:12px; color:#8a7a63; margin-top:32px; line-height:1.6;">
        Merci &amp; grazie for your order. If anything looks off, just reply to this email and we'll sort it out.
      </p>
    </div>
  </div>`;
}

async function sendOrderEmail(order: {
  order_number: string;
  customer_name: string;
  customer_email: string;
  items: { name: string; price: number; qty: number }[];
  subtotal: number;
  currency: string;
}) {
  if (!RESEND_API_KEY || !order.customer_email) return;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: order.customer_email,
        subject: `Order ${order.order_number} confirmed — Maison & Bottega`,
        html: buildOrderEmailHtml(order),
      }),
    });
    if (!res.ok) {
      console.error("Resend error:", await res.text());
    }
  } catch (e) {
    // Email failures should never break payment verification.
    console.error("Failed to send order email:", e.message);
  }
}

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

    const orderNumber = updated ? `MB-${String(updated.order_seq).padStart(7, "0")}` : null;

    if (valid && updated && orderNumber) {
      // Fire-and-forget-ish: awaited, but errors inside are caught and
      // never affect the response sent back to the customer's browser.
      await sendOrderEmail({
        order_number: orderNumber,
        customer_name: updated.customer_name,
        customer_email: updated.customer_email,
        items: updated.items,
        subtotal: updated.subtotal,
        currency: updated.currency,
      });
    }

    return new Response(
      JSON.stringify({
        success: valid,
        order_number: orderNumber,
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
