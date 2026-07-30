// Shared by verify-razorpay-payment and admin-update-order-status.
// This folder is prefixed with an underscore, which the Supabase CLI
// treats as a shared module rather than a deployable function.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") ?? "Maison & Bottega <onboarding@resend.dev>";

export type OrderItem = { name: string; price: number; qty: number };

export type EmailOrder = {
  order_number: string;
  customer_name: string;
  customer_email: string;
  items: OrderItem[];
  subtotal: number;
  currency: string;
};

type EmailKind = "confirmed" | "ready" | "cancelled";

const COPY: Record<EmailKind, { eyebrow: string; heading: (o: EmailOrder) => string; note: string }> = {
  confirmed: {
    eyebrow: "Order Confirmed",
    heading: (o) => `Bonjour ${o.customer_name || "there"}, buongiorno — your order is confirmed. Here's what's coming your way:`,
    note: "Merci &amp; grazie for your order. If anything looks off, just reply to this email and we'll sort it out.",
  },
  ready: {
    eyebrow: "Ready for Pickup",
    heading: (o) => `Bonjour ${o.customer_name || "there"} — your order is fresh, boxed, and waiting for you at the counter.`,
    note: "Come by during our opening hours with this order number. See you soon!",
  },
  cancelled: {
    eyebrow: "Order Cancelled",
    heading: (o) => `Bonjour ${o.customer_name || "there"} — your order has been cancelled and a refund has been initiated.`,
    note: "Refunds typically take 5–7 business days to appear back on your original payment method, depending on your bank.",
  },
};

function buildOrderEmailHtml(kind: EmailKind, order: EmailOrder): string {
  const copy = COPY[kind];
  const rows = order.items.map((i) => `
    <tr>
      <td style="padding:10px 0; border-bottom:1px solid #e7ded0; font-family:Georgia, serif; font-style:italic; color:#2A1D14;">${i.name}</td>
      <td style="padding:10px 0; border-bottom:1px solid #e7ded0; text-align:center; font-family:monospace; color:#5A493B;">×${i.qty}</td>
      <td style="padding:10px 0; border-bottom:1px solid #e7ded0; text-align:right; font-family:monospace; color:#2A1D14;">₹${i.price * i.qty}</td>
    </tr>`).join("");

  return `
  <div style="background:#F7F1E6; padding:40px 20px; font-family:Helvetica, Arial, sans-serif;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border:1px solid #e7ded0; padding:36px;">
      <p style="font-family:Georgia, serif; font-size:22px; color:#2A1D14; margin:0 0 4px;">Maison &amp; Bottega</p>
      <p style="font-size:11px; letter-spacing:2px; text-transform:uppercase; color:#AD3A52; margin:0 0 28px;">${copy.eyebrow}</p>

      <p style="font-family:Georgia, serif; font-style:italic; font-size:26px; color:#AD3A52; border:1px dashed #AD3A52; display:inline-block; padding:8px 18px; border-radius:999px; margin:0 0 24px;">${order.order_number}</p>

      <p style="font-size:14px; color:#2A1D14; margin:0 0 20px;">${copy.heading(order)}</p>

      <table style="width:100%; border-collapse:collapse; margin-bottom:16px;">
        ${rows}
      </table>

      <table style="width:100%; border-top:2px solid #2A1D14; padding-top:10px;">
        <tr>
          <td style="font-family:Georgia, serif; font-size:16px; color:#2A1D14; padding-top:10px;">${kind === "cancelled" ? "Refund amount" : "Total paid"}</td>
          <td style="font-family:monospace; font-size:16px; color:#2A1D14; text-align:right; padding-top:10px;">₹${order.subtotal}</td>
        </tr>
      </table>

      <p style="font-size:12px; color:#8a7a63; margin-top:32px; line-height:1.6;">${copy.note}</p>
    </div>
  </div>`;
}

export async function sendOrderEmail(kind: EmailKind, order: EmailOrder) {
  if (!RESEND_API_KEY || !order.customer_email) return;

  const subjectByKind: Record<EmailKind, string> = {
    confirmed: `Order ${order.order_number} confirmed — Maison & Bottega`,
    ready: `Order ${order.order_number} is ready for pickup!`,
    cancelled: `Order ${order.order_number} has been cancelled`,
  };

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
        subject: subjectByKind[kind],
        html: buildOrderEmailHtml(kind, order),
      }),
    });
    if (!res.ok) {
      console.error("Resend error:", await res.text());
    }
  } catch (e) {
    // Email failures should never break the calling function's main job.
    console.error("Failed to send order email:", e.message);
  }
}
