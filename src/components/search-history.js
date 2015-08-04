import Component from './component'
import searchHistoryDataSource from '../dataSources/search-history-dataSource';

searchHistoryDataSource.online(false);

searchHistoryDataSource.bind('change', function() {
	if (this.view().length > 0) {
		Component.trigger('artist/select', { artist: this.view()[0] });
	}
})

let observable = kendo.observable({
	searchHistoryDataSource: searchHistoryDataSource,
	selectHistoryItem: function(e) {
		var artistId = ($(e.target).data('id'));
		var artist = searchHistoryDataSource.get(artistId);
		
		Component.trigger('artist/select', { artist: artist })

		e.preventDefault();
	}
});

const template = `
	<h3>History</h3>

	<div data-bind="source: searchHistoryDataSource" data-auto-bind="false" data-template="search-history-template"></div>

	<script id="search-history-template" type="text/x-kendo-template">
		<p><a href="\\\#" data-bind="click: selectHistoryItem" data-id="#: artistId #">#: artistName #</a></p>
	</script>`;

class SearchHistory extends Component {

	constructor(container) {

		super(container, template, observable, true);

		Component.on('artist/select', function(e, args) {
			// compare the first item, if it's this one, no need to add it again
			let firstItem = searchHistoryDataSource.at(0) || { artistId: null };
			
			if (args.artist.artistId !== firstItem.artistId) {
				searchHistoryDataSource.insert(0, args.artist);
				searchHistoryDataSource.sync();
			}
		});

		Component.on('searchHistory/read', function() {
			searchHistoryDataSource.read();
		})
	}
}

export default SearchHistory;