// Deploy WITHOUT --no-verify-jwt (this is intentional — unlike the two
// customer-facing functions, this one should only run for a signed-in
// Supabase Auth user, and the platform gateway enforces that check for
// us automatically when JWT verification is left on):
//
//   supabase functions deploy admin-update-order-status
//
// Required secrets (same values as create-razorpay-order):
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, PROJECT_URL, SERVICE_ROLE_KEY
//   RESEND_API_KEY, FROM_EMAIL (see _shared/email.ts)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendOrderEmail } from "../_shared/email.ts";

const RAZORPAY_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID")!;
const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET")!;
const PROJECT_URL = Deno.env.get("PROJECT_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const ALLOWED_STATUSES = ["pending", "paid", "preparing", "ready_for_pickup", "completed", "cancelled", "failed"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // tighten to your admin.html's real origin once live
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { db_order_id, new_status } = await req.json();

    if (!db_order_id || !ALLOWED_STATUSES.includes(new_status)) {
      return new Response(JSON.stringify({ error: "Invalid request" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(PROJECT_URL, SERVICE_ROLE_KEY);

    const { data: order, error: fetchError } = await supabase
      .from("orders")
      .select("*")
      .eq("id", db_order_id)
      .single();

    if (fetchError || !order) {
      return new Response(JSON.stringify({ error: "Order not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (new_status === "cancelled" && order.status === "cancelled") {
      return new Response(JSON.stringify({ error: "Order is already cancelled" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let refundId: string | null = order.razorpay_refund_id ?? null;

    // Only refund if the order was actually paid for, and hasn't been refunded already.
    if (new_status === "cancelled" && order.razorpay_payment_id && !order.razorpay_refund_id) {
      const refundRes = await fetch(
        `https://api.razorpay.com/v1/payments/${order.razorpay_payment_id}/refund`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
          },
          body: JSON.stringify({}), // omitting 'amount' issues a full refund
        }
      );

      if (!refundRes.ok) {
        const detail = await refundRes.text();
        return new Response(JSON.stringify({ error: "Refund failed", detail }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const refund = await refundRes.json();
      refundId = refund.id;
    }

    const { data: updated, error: updateError } = await supabase
      .from("orders")
      .update({
        status: new_status,
        razorpay_refund_id: refundId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", db_order_id)
      .select()
      .single();

    if (updateError || !updated) {
      return new Response(JSON.stringify({ error: "Could not update order" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const orderNumber = `MB-${String(updated.order_seq).padStart(7, "0")}`;
    const emailOrder = {
      order_number: orderNumber,
      customer_name: updated.customer_name,
      customer_email: updated.customer_email,
      items: updated.items,
      subtotal: updated.subtotal,
      currency: updated.currency,
    };

    if (new_status === "ready_for_pickup") {
      await sendOrderEmail("ready", emailOrder);
    } else if (new_status === "cancelled") {
      await sendOrderEmail("cancelled", emailOrder);
    }

    return new Response(
      JSON.stringify({ success: true, order: updated, order_number: orderNumber, refund_id: refundId }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
