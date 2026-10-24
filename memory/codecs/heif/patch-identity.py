from pathlib import Path
import sys
p=Path(sys.argv[1]);s=p.read_text()
needle='''  else if (m_elst &&
           m_elst->num_entries() == 1 &&
           m_elst->get_entry(0).media_time == 0 &&
           m_elst->get_entry(0).segment_duration == m_mdhd->get_duration() &&
           m_elst->is_repeat_mode()) {'''
replacement='''  else if (m_elst &&
           m_elst->num_entries() == 1 &&
           m_elst->get_entry(0).media_time == 0 &&
           m_elst->get_entry(0).segment_duration == m_mdhd->get_duration() &&
           m_elst->get_entry(0).media_rate_integer == 1 &&
           m_elst->get_entry(0).media_rate_fraction == 0 &&
           !m_elst->is_repeat_mode() &&
           m_heif_context->get_sequence_duration() == m_mdhd->get_duration() &&
           current_decoding_time == m_mdhd->get_duration()) {
    // HY prototype: equal movie/track clocks were established above. This one
    // unit-rate edit selects the complete media timeline exactly once.
    m_num_output_samples = media_timeline.size();
    m_num_repetitions = 1;
  }
  else if (m_elst &&
           m_elst->num_entries() == 1 &&
           m_elst->get_entry(0).media_time == 0 &&
           m_elst->get_entry(0).segment_duration == m_mdhd->get_duration() &&
           m_elst->get_entry(0).media_rate_integer == 1 &&
           m_elst->get_entry(0).media_rate_fraction == 0 &&
           m_elst->is_repeat_mode()) {'''
if needle in s:
 if s.count(needle)!=1:raise SystemExit('unexpected identity edit source')
 s=s.replace(needle,replacement)
elif replacement not in s:raise SystemExit('unexpected identity edit source')
p.write_text(s)
