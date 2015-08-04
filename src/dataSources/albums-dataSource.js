import Component from '../components/component';
import itunes from '../itunes-api';

let albumsDataSource = new kendo.data.DataSource({
	transport: {
		read: {
			url: itunes.LOOKUP,
			dataType: 'jsonp',
			data: function(args) {
				return {
					entity: 'album',
					id: args.id
				}
			}
		}
	},
	schema: {
		data: "results",
			parse: function(data) {
				$.each(data.results, function() {
					// add a place holder on the albums ds for tracks which is not 
					// included in the original response
					
					this.tracks = new kendo.data.ObservableArray([]);

					// set the artist name
				  Component.trigger('artist/update', data.results[0].artistName);
			});

			kendo.ui.progress($('#main'), false);

			return data;
		},
		model: {
			id: "collectionId",
				fields: {
					releaseDate: {
	  			type: "date"
				}
			}
		}
	},
	filter: { field: "wrapperType", operator: "equals", value: "collection" }
});

export default albumsDataSource;