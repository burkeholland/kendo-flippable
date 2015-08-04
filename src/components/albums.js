import Component from './component';
import albumsDataSource from '../dataSources/albums-dataSource';
import tracksDataSource from '../dataSources/tracks-dataSource';
import itunes from '../itunes-api';

let albumId = null,
	  currentTrack = kendo.observable({});

tracksDataSource.bind('change', function() {
	let albums = albumsDataSource.get(albumId);
	albums.set('tracks', this.view());
});

var observable = kendo.observable({
	isEmpty: true,
	tracksDataSource: tracksDataSource,
	albumsDataSource: albumsDataSource,
	flip: function(e) {

	  let flippable = $(e.sender.element)
	  									.closest("[data-role='flippable']")
	  									.data('kendoFlippable');
	
	  flippable.flipHorizontal();
	},
	
	flipStart: function(e) {

		albumId = e.data.collectionId;

	  // if we're flipping the same album back over, stop the track
	  if (albumId === currentTrack.collectionId) {
			Component.trigger('player/pause');
			currentTrack.set('isPlaying', false);
	  }

	  // only make a remote call for tracks if there are not yet any 
	  // tracks associated with this album
	  if (e.data.tracks.length > 0) {
	    return;
	  }
	  else {
	  	tracksDataSource.read({ id: e.data.collectionId });
	  }
	},

	play: function(e) {

		currentTrack.set('isPlaying', false);

		currentTrack = e.data;

		Component.trigger('player/play', currentTrack);  
		currentTrack.set('isPlaying', true); 
	},

	stop: function(e) {
		Component.trigger('player/stop');
		e.data.set('isPlaying', false);
	},

	search: function(e) {
		Component.trigger('open/search');
		e.preventDefault();
	}
});

const template = `
	<div>
	  <div class="albums" data-bind="source: albumsDataSource" data-template="albums-template">
	  </div>
	  <div class="empty" data-bind="visible: isEmpty">
	    <a href="#" data-bind="click: search"><i class="fa fa-music"></i></a>
	  </div>
	</div>

	<script type="text/x-kendo-template" id="albums-template">
	  <div class="col-sm-4">
	    <div class="album" data-role="flippable" data-bind="events: { flipStart: flipStart }">
	      <div class="front" data-role="touch" data-bind="events: { tap: flip }">
	        <div class="col-lg-5">
	          <div class="album-cover">
	            <img class="img-circle" src="#: artworkUrl100 #">
	            <p><span class="badge">#: trackCount #</span> tracks</p>
	          </div>
	        </div>
	        <div class="col-lg-7">
	          <div class="row">
	            <div class="col-xs-12">
	              <h4 title="#: collectionCensoredName #"> #: collectionCensoredName #</h4>
	            </div>
	            <div class="col-xs-12 hidden-md hidden-sm">
	              <p>Released #: kendo.toString(releaseDate, "MMM d, yyyy") #</p>
	            </div>
	          </div>
	        </div>
	      </div>
	      <div class="back">
	        <div data-role="kendo.mobile.ui.NavBar">
	          <span data-role="kendo.mobile.ui.ViewTitle">Tracks</span>
	          <div data-role="kendo.mobile.ui.Button" data-bind="click: flip" data-align="left">Back</div>
	        </div> 
	        <div class="tracks">
	          <ul data-role="kendo.mobile.ui.ListView" data-bind="source: tracks" data-auto-bind="false" data-template="track-template"></table>
	        </div>
	      </div>
	    </div>
	  </div>
	</script>

	<script type="text/x-kendo-template" id="track-template">
		<span data-role="progress-bar"></span>
	  <i class="fa fa-play" data-bind="click: play, invisible: isPlaying">
	    <span> #: trackName #</span>
	  </i>
	  <i class="fa fa-pause" data-bind="click: stop, visible: isPlaying">
	    <span> #: trackName #</span>
	  </i>
	</script>`;

class Albums extends Component {

	constructor(container) {
		
		super(container, template, observable, true);

		Component.on('artist/select', (e, args) => {

			kendo.ui.progress($('#main'), true);

			observable.get('albumsDataSource').read({ id: args.artist.artistId });
			observable.set('isEmpty', false);
		});
	}
}

export default Albums;