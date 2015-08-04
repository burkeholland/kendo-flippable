import 'jquery'
import './kendo';
import 'kendo-flippable';

import SearchBox from './components/search-box';
import Artist from './components/artist';
import Player from './components/player';

new Player(document.body);

new SearchBox('#main');

new Artist('#main');

kendo.ui.progress($('.container'), true);
