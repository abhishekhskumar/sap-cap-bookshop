module.exports = (srv) => {
  const reviewsData = [
    { book_id: 101, rating: 4.8, reviewCount: 2847, summary: 'A sci-fi masterpiece' },
    { book_id: 102, rating: 4.7, reviewCount: 3201, summary: 'A chilling dystopian classic' }
  ];

  srv.before('READ', 'Reviews', async () => {
    const { Reviews } = srv.entities;
    const existing = await SELECT.from(Reviews);
    if (existing.length === 0) {
      await INSERT(reviewsData).into(Reviews);
    }
  });
};
