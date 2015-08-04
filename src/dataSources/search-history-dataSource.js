let searchHistoryDataSource = new kendo.data.DataSource({
	offlineStorage: 'search-history',
	schema: {
		model: {
			id: 'artistId'
		},
		parse: function(data) {
			return data.reverse();
		}
	}
});

export default searchHistoryDataSource;