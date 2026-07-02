module.exports = (srv) => {

  // 1. Computed field (from before)
  srv.after('READ', 'Books', (books) => {
    for (const book of books) {
      book.stockStatus = book.stock > 0 ? 'in stock' : 'out of stock';
      book.criticality = book.stock > 0 ? 3 : 1;   // 3 = green, 1 = red
    }
  });

  // 2. Validation: reject bad data before it's saved
  srv.before('CREATE', 'Books', (req) => {
    const { title, stock } = req.data;
    if (!title) {
      return req.error(400, 'A book must have a title.');
    }
    if (stock < 0) {
      return req.error(400, 'Stock cannot be negative.');
    }
  });

  // 3. Custom action: add quantity to a book's stock
  srv.on('restock', async (req) => {
    const { book, quantity } = req.data;
    const { Books } = srv.entities;

    if (quantity <= 0) {
      return req.error(400, 'Quantity must be greater than zero.');
    }

    const found = await SELECT.one.from(Books).where({ ID: book });
    if (!found) {
      return req.error(404, `No book found with ID ${book}.`);
    }

    await UPDATE(Books).set({ stock: found.stock + quantity }).where({ ID: book });
    return `Restocked "${found.title}" by ${quantity}. New stock: ${found.stock + quantity}.`;
  });

};