import itunes from '../itunes-api';

let tracksDataSource = new kendo.data.DataSource({
  transport: {
    read: {
  		url: itunes.LOOKUP,
  		dataType: 'jsonp',
  		data: function(args) {
  			return {
  				entity: 'song',
  				id: args.id
  			}
  		}
    }
  },
  schema: {
    data: 'results',
    parse: function(data) {
      // add a default 'isPlaying' flag which will be used later to determine
      // the state of a particular track in the UI
      $.each(data.results, function() {
        this.isPlaying = false;
      });
      return data;
    },
    model: {
      id: 'collectionId',
      fields: {
        releaseDate: {
          type: 'date'
        }
      }
    }
  },
  filter: { field: 'wrapperType', operator: 'equals', value: 'track' }
});

export default tracksDataSource;