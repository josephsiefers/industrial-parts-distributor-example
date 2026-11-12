# Order Intake

Turning customers' emailed purchase orders into correct sales orders in the distributor's ERP, work currently done by hand by inside-sales reps.

## Language

**Purchase Order**:
The document a customer sends to the distributor to buy parts, written in the customer's terms (their part numbers, units, and formatting).
_Avoid_: PO (in prose), order (unqualified), request

**Sales Order**:
The record the distributor creates in its ERP to fulfil a Purchase Order, written in the distributor's terms (its SKUs, customer account, prices).
_Avoid_: order (unqualified), ERP order, entry

**SKU**:
The distributor's own identifier for a part it sells.
_Avoid_: item number, part number (unqualified)

**Customer Part Number**:
A customer's own identifier for a part, which the customer writes on its Purchase Orders in place of the SKU.
_Avoid_: CPN, their SKU

**Cross-Reference**:
A per-customer mapping from a Customer Part Number to a SKU.
_Avoid_: xref, alias table, mapping

**Straight-Through Processing**:
Turning a Purchase Order into a posted Sales Order with no Inside-Sales Rep touching it.
_Avoid_: touchless, auto-processing

**Review Queue**:
Where a draft Sales Order waits for an Inside-Sales Rep when it can't go straight through, along with the flags explaining why.
_Avoid_: exceptions queue, inbox

**Inside-Sales Rep**:
A distributor employee who currently reads incoming Purchase Orders and keys them into the ERP as Sales Orders.
_Avoid_: CSR, order-entry clerk, keyer
