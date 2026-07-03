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

  // 2. Validation on create
  srv.before('CREATE', 'Books', (req) => {
    const { title, stock } = req.data;
    if (!title)    return req.error(400, 'A book must have a title.');
    if (stock < 0) return req.error(400, 'Stock cannot be negative.');
  });

  // 3. Validation on edit
  srv.before('UPDATE', 'Books', (req) => {
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

    return `Restocked "${found.title}" by ${quantity}. New stock: ${newStock}.`;
  });

};