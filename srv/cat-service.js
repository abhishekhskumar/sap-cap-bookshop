const cds = require('@sap/cds');

module.exports = (srv) => {

  srv.before(['CREATE','UPDATE','DELETE'], 'Books', (req) => {
    if (!req.user.is('admin'))
      return req.reject(403, 'Only admins can modify books.');
  });

  srv.before('restock', 'Books', (req) => {
    if (!req.user.is('admin'))
      return req.reject(403, 'Only admins can restock.');
  });

  // 1. Computed fields
  srv.after(['READ', 'EDIT'], 'Books', (books) => {
    const list = Array.isArray(books) ? books : [books];
    for (const book of list) {
      book.stockStatus = book.stock > 0 ? 'in stock' : 'out of stock';
      book.criticality = book.stock > 0 ? 3 : 1;
    }
  });

  // 2. Validation on create (skip for draft inserts — title may be empty until draftActivate)
  srv.before('CREATE', 'Books', (req) => {
    if (req.target?.isDraft) return;
    const { title, stock } = req.data;
    if (!title)    return req.error(400, 'A book must have a title.');
    if (stock < 0) return req.error(400, 'Stock cannot be negative.');
  });

  // 3. Validation on edit (skip for draft patches — validate at draftActivate time)
  srv.before('UPDATE', 'Books', (req) => {
    if (req.target?.isDraft) return;
    const { title, stock } = req.data;
    if (title !== undefined && !title)
      return req.error(400, 'A book must have a title.');
    if (stock !== undefined && stock < 0)
      return req.error(400, 'Stock cannot be negative.');
  });

  // 4. Restock — bound action
  srv.on('restock', 'Books', async (req) => {
    const { quantity } = req.data;
    const ID = req.params[0].ID;
    const { Books } = srv.entities;

    if (!quantity || quantity <= 0)
      return req.error(400, 'Quantity must be greater than zero.');

    const found = await SELECT.one.from(Books)
    .columns('ID', 'title', 'stock')
      .where({ ID });

    if (!found)
      return req.error(404, `No book found with ID ${ID}.`);

    const newStock = found.stock + quantity;
    await UPDATE(Books)
      .set({ stock: newStock })
      .where({ ID });

    // Emit restock event
    srv.emit('BookRestocked', {
      book_id: ID,
      title: found.title,
      quantity,
      newStock,
      timestamp: new Date().toISOString()
    });

    // Emit low stock alert if stock drops below 10
    if (newStock < 10) {
      srv.emit('LowStock', {
        book_id: ID,
        title: found.title,
        stock: newStock,
        timestamp: new Date().toISOString()
      });
    }

    return `Restocked "${found.title}" by ${quantity}. New stock: ${newStock}.`;
  });

  // ── External service consumption ──────────────────────────

  // Connect to the external ReviewsAPI
  srv.on('getBookReview', async (req) => {
    const { book_id } = req.data;
    const reviewsApi = await cds.connect.to('ReviewsAPI');
    const { Reviews } = reviewsApi.entities;
    const result = await reviewsApi.run(
      SELECT.one.from(Reviews).where({ book_id })
    );
    if (!result) return req.error(404, 'No review found for book ' + book_id);
    return {
      rating: result.rating,
      reviewCount: result.reviewCount,
      summary: result.summary
    };
  });

  // Enrich Books READ with review data
  srv.on('READ', 'Reviews', async (req) => {
    const reviewsApi = await cds.connect.to('ReviewsAPI');
    return reviewsApi.run(req.query);
  });

  // ── Event listeners ─────────────────────────────────────────

  srv.on('BookRestocked', async (msg) => {
    const { book_id, title, quantity, newStock, timestamp } = msg.data;
    console.log(`[EVENT] BookRestocked: "${title}" +${quantity} → stock: ${newStock}`);

    // Write to audit log
    await INSERT.into('my.bookshop.AuditLog').entries({
      ID: cds.utils.uuid(),
      action: 'RESTOCK',
      entity_: 'Books',
      entityKey: String(book_id),
      details: `Restocked "${title}" by ${quantity}. New stock: ${newStock}`,
      user: 'system',
      timestamp
    });
  });

  srv.on('LowStock', async (msg) => {
    const { book_id, title, stock, timestamp } = msg.data;
    console.log(`[ALERT] LowStock: "${title}" only ${stock} left!`);

    // Write alert to audit log
    await INSERT.into('my.bookshop.AuditLog').entries({
      ID: cds.utils.uuid(),
      action: 'LOW_STOCK_ALERT',
      entity_: 'Books',
      entityKey: String(book_id),
      details: `Low stock alert: "${title}" has only ${stock} units`,
      user: 'system',
      timestamp
    });
  });

};