(function(f, define){
    define([ "./kendo.core", "./kendo.fx" ], f);
})(function(){

var __meta__ = {
    id: "flippable",
    name: "Flippable",
    category: "web",
    description: "The flippable widget displays a card that flips from front to back.",
    depends: [ "core", "fx" ]
};

(function ($, undefined) {
  
    var kendo = window.kendo,
        ui = kendo.ui,
        Widget = ui.Widget,
        CLICK = "click",
        FLIPSTART = "flipStart",
        FLIPEND = "flipEnd",
        NS = ".kendoFlip",
        proxy = $.proxy;

    var Flippable = Widget.extend({
        
        init: function(element, options) {

            var that = this,
                panes = $(element).children();

            Widget.fn.init.call(this, element, options);

            element = that.element;

            that._setContainerCSS(that.element);

            that._setPanesCSS(panes);

            that._initEffect(element, panes);

            element.on(CLICK + NS, proxy(that._click, that));
            element.on(FLIPSTART + NS, proxy(that._flipStart, that));
            element.on(FLIPEND + NS, proxy(that._flipEnd, that));

            $(panes[0]).hide();

            element.show();
        },

        options: {
            height: 400,
            name: "Flippable",
            duration: 800
        },
    
        events: [
            CLICK
        ],
    
        flipVertical: function() {
            this._flip(this.flipV);
        },

        flipHorizontal: function() {
            this._flip(this.flipH);
        },

        _flip: function(effect) {
            var reverse = this.reverse;

            effect.stop();

            this._flipStart(this);

            reverse ? effect.reverse().then(this._flipEnd(this)) : effect.play().then(this._flipEnd(this));
            this.reverse = !reverse;
        },

        _flipStart: function(e) {
            this.trigger(FLIPSTART, { event: e });
        },

        _flipEnd: function(e) {
            this.trigger(FLIPEND, { event: e });
        },

        _setContainerCSS: function(container) {

            container.css({
                position: "relative"
            });

        },

        _setPanesCSS: function(panes) {
            
            panes.each(function() {

                var pane = $(this);
                var clone = $(this).clone();

                pane.css({
                    position: "absolute",
                    width: "100%",
                    height: "100%"
                });

                clone.remove();
            });
        },

        _initEffect: function(container, panes) {
            
            var that = this,
            front = panes[1],
            back = panes[0];

            that.flipH = kendo.fx(container)
                              .flipHorizontal(front, back)
                              .duration(that.options.duration);

            that.flipV = kendo.fx(container)
                              .flipVertical(front, back)
                              .duration(that.options.duration);

            that.reverse = false;
        },

        _click: function (e) {
           this.trigger(CLICK, { event: e });
        }
    });

    ui.plugin(Flippable);

})(window.kendo.jQuery);

return window.kendo;

}, typeof define == 'function' && define.amd ? define : function(_, f){ f(); });
